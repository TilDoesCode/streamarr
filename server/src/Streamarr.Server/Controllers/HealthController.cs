using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Controllers;

public sealed record ReachabilityStatus
{
    public required string Name { get; init; }
    public required bool Reachable { get; init; }
    public double? LatencyMs { get; init; }
    public string? Error { get; init; }
}

public sealed record HealthResponse
{
    public required string Status { get; init; }
    public required string Version { get; init; }
    public IReadOnlyList<ReachabilityStatus> Indexers { get; init; } = [];
    public IReadOnlyList<ReachabilityStatus> Providers { get; init; } = [];
}

/// <summary>
/// GET /api/v1/health: anonymous, shallow liveness by default. Credentialed dependency
/// diagnostics require an admin JWT and are shared/cached to prevent probe amplification.
/// </summary>
[ApiController]
[AllowAnonymous]
[EnableRateLimiting("health")]
[Route("api/v1/health")]
public class HealthController(DeepHealthDiagnostics diagnostics) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(HealthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<HealthResponse>> Get([FromQuery] bool deep = false, CancellationToken ct = default)
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

        if (!deep)
            return Ok(new HealthResponse { Status = "ok", Version = version });

        if (User.Identity?.IsAuthenticated != true)
            return Unauthorized(ErrorResponse.Of("unauthorized", "Admin credentials are required for deep health diagnostics."));
        if (!User.IsInRole(AuthRoles.Admin))
            return Forbid();

        var snapshot = await diagnostics.GetAsync(ct);
        return Ok(snapshot with { Version = version });
    }
}

/// <summary>One probed dependency (indexer or provider) with the raw error for admin diagnostics.</summary>
public sealed record DependencyProbe
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Reachable { get; init; }
    public double? LatencyMs { get; init; }

    /// <summary><c>timeout</c>, <c>auth_failed</c>, <c>http_error</c>, <c>invalid_response</c> or <c>unreachable</c>.</summary>
    public string? ErrorCode { get; init; }

    /// <summary>Raw error text; admin eyes only (may name hosts).</summary>
    public string? Error { get; init; }

    public int? Priority { get; init; }
}

/// <summary>A shared, cached probe of every external dependency.</summary>
public sealed record DependencySnapshot
{
    public required IReadOnlyList<DependencyProbe> Indexers { get; init; }
    public required IReadOnlyList<DependencyProbe> Providers { get; init; }
    public bool ProviderListFailed { get; init; }

    /// <summary>Null when the TMDB client cannot probe.</summary>
    public TmdbProbeResult? Tmdb { get; init; }

    public double? TmdbLatencyMs { get; init; }
    public required DateTimeOffset CheckedAt { get; init; }
}

/// <summary>Singleton dependency-probe cache with stampede protection and a hard timeout.</summary>
public sealed class DeepHealthDiagnostics(
    IIndexerConfigStore indexers,
    IndexerCapsTester indexerTester,
    ProviderConfigService providers,
    ProviderConnectionTester providerTester,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ITmdbClient? tmdb = null)
{
    /// <summary>A forced refresh never re-probes a snapshot younger than this.</summary>
    public static readonly TimeSpan MinRefreshInterval = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan IndexerTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan TmdbTimeout = TimeSpan.FromSeconds(10);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private DependencySnapshot? _cached;
    private DateTimeOffset _expiresAt;

    public async Task<HealthResponse> GetAsync(CancellationToken ct)
    {
        var snapshot = await GetSnapshotAsync(refresh: false, ct);
        var indexerResults = snapshot.Indexers.Select(ToReachability).ToArray();
        var providerResults = snapshot.Providers.Select(ToReachability).ToArray();
        var allReachable = !snapshot.ProviderListFailed && indexerResults.All(r => r.Reachable) &&
                           providerResults.All(r => r.Reachable);

        return new HealthResponse
        {
            Status = allReachable ? "ok" : "degraded",
            Version = "unknown",
            Indexers = indexerResults,
            Providers = providerResults,
        };
    }

    /// <summary>The cached snapshot; <paramref name="refresh"/> re-probes unless the snapshot is younger than <see cref="MinRefreshInterval"/>.</summary>
    public async Task<DependencySnapshot> GetSnapshotAsync(bool refresh, CancellationToken ct)
    {
        if (Fresh(refresh) is { } current)
            return current;

        await _gate.WaitAsync(ct);
        try
        {
            if (Fresh(refresh) is { } afterWait)
                return afterWait;

            var result = await ProbeAsync();
            _cached = result;
            _expiresAt = time.GetUtcNow().AddSeconds(options.Value.DeepHealthCacheSeconds);
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    private DependencySnapshot? Fresh(bool refresh)
    {
        if (_cached is not { } cached)
            return null;
        var now = time.GetUtcNow();
        if (_expiresAt <= now)
            return null;
        return refresh && now - cached.CheckedAt >= MinRefreshInterval ? null : cached;
    }

    private static ReachabilityStatus ToReachability(DependencyProbe probe) => new()
    {
        Name = probe.Name,
        Reachable = probe.Reachable,
        LatencyMs = probe.LatencyMs,
        Error = probe.Reachable ? null : probe.ErrorCode == "timeout" ? "timed out" : "unreachable",
    };

    private async Task<DependencySnapshot> ProbeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var probeCt = timeout.Token;

        var indexerChecks = indexers.GetEnabled()
            .Take(options.Value.Search.MaxIndexersPerSearch)
            .Select(async i =>
        {
            var sw = Stopwatch.StartNew();
            try
            {
                using var own = CancellationTokenSource.CreateLinkedTokenSource(probeCt);
                own.CancelAfter(IndexerTimeout);
                var result = await indexerTester.TestAsync(i, own.Token);
                return new DependencyProbe
                {
                    Id = i.Id,
                    Name = i.Name,
                    Reachable = result.Success,
                    LatencyMs = result.LatencyMs,
                    ErrorCode = result.Success ? null : result.ErrorCode ?? "unreachable",
                    Error = result.Success ? null : result.ErrorDetail ?? result.Error,
                };
            }
            catch (OperationCanceledException)
            {
                return new DependencyProbe { Id = i.Id, Name = i.Name, Reachable = false, LatencyMs = sw.Elapsed.TotalMilliseconds, ErrorCode = "timeout", Error = "timed out" };
            }
            catch (Exception e)
            {
                return new DependencyProbe { Id = i.Id, Name = i.Name, Reachable = false, ErrorCode = "unreachable", Error = e.GetType().Name };
            }
        });

        IReadOnlyList<Persistence.Entities.ProviderEntity> providerEntities;
        var providerListFailed = false;
        try
        {
            providerEntities = await providers.ListAsync(probeCt);
        }
        catch
        {
            providerEntities = [];
            providerListFailed = true;
        }

        using var providerGate = new SemaphoreSlim(4, 4);
        var providerChecks = providerEntities.Where(p => p.Enabled).OrderBy(p => p.Priority).Take(32).Select(async p =>
        {
            var acquired = false;
            var sw = new Stopwatch();
            try
            {
                await providerGate.WaitAsync(probeCt);
                acquired = true;
                sw.Start();
                var (ok, error) = await providerTester.ProbeAsync(providers.ToProvider(p), probeCt);
                sw.Stop();
                return new DependencyProbe
                {
                    Id = p.Id,
                    Name = p.Name,
                    Reachable = ok,
                    LatencyMs = sw.Elapsed.TotalMilliseconds,
                    ErrorCode = ok ? null : ClassifyProvider(error),
                    Error = ok ? null : error,
                    Priority = p.Priority,
                };
            }
            catch (OperationCanceledException)
            {
                return new DependencyProbe { Id = p.Id, Name = p.Name, Reachable = false, ErrorCode = "timeout", Error = "timed out", Priority = p.Priority };
            }
            catch (Exception e)
            {
                return new DependencyProbe { Id = p.Id, Name = p.Name, Reachable = false, ErrorCode = "unreachable", Error = e.GetType().Name, Priority = p.Priority };
            }
            finally
            {
                if (acquired)
                    providerGate.Release();
            }
        });

        var tmdbCheck = ProbeTmdbAsync(probeCt);
        var indexerResults = await Task.WhenAll(indexerChecks);
        var providerResults = await Task.WhenAll(providerChecks);
        var (tmdbResult, tmdbLatency) = await tmdbCheck;

        return new DependencySnapshot
        {
            Indexers = indexerResults,
            Providers = providerResults,
            ProviderListFailed = providerListFailed,
            Tmdb = tmdbResult,
            TmdbLatencyMs = tmdbLatency,
            CheckedAt = time.GetUtcNow(),
        };
    }

    private async Task<(TmdbProbeResult?, double?)> ProbeTmdbAsync(CancellationToken ct)
    {
        if (tmdb is null)
            return (null, null);
        var sw = Stopwatch.StartNew();
        try
        {
            using var own = CancellationTokenSource.CreateLinkedTokenSource(ct);
            own.CancelAfter(TmdbTimeout);
            var result = await tmdb.ProbeAsync(own.Token);
            return (result, result is { ErrorCode: "not_configured" } ? null : sw.Elapsed.TotalMilliseconds);
        }
        catch (OperationCanceledException)
        {
            return (new TmdbProbeResult(false, "timeout", "TMDB did not answer in time."), sw.Elapsed.TotalMilliseconds);
        }
        catch (Exception e)
        {
            return (new TmdbProbeResult(false, "unreachable", e.GetType().Name), sw.Elapsed.TotalMilliseconds);
        }
    }

    internal static string ClassifyProvider(string? error)
    {
        if (error is null)
            return "unreachable";
        if (error.StartsWith(ProviderConnectionTester.AuthFailedPrefix, StringComparison.Ordinal))
            return "auth_failed";
        if (error == ProviderConnectionTester.TimedOutError)
            return "timeout";
        return "unreachable";
    }
}
