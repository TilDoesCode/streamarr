using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
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

        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (User.Identity?.IsAuthenticated != true)
            return Unauthorized(ErrorResponse.Of("unauthorized", "Admin credentials are required for deep health diagnostics."));
        if (!User.IsInRole(AuthRoles.Admin))
            return Forbid();

        var snapshot = await diagnostics.GetAsync(ct);
        return Ok(snapshot with { Version = version });
    }
}

/// <summary>Singleton dependency-probe cache with stampede protection and a hard timeout.</summary>
public sealed class DeepHealthDiagnostics(
    IIndexerConfigStore indexers,
    IndexerCapsTester indexerTester,
    ProviderConfigService providers,
    ProviderConnectionTester providerTester,
    IOptions<StreamarrOptions> options,
    TimeProvider time)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private HealthResponse? _cached;
    private DateTimeOffset _expiresAt;

    public async Task<HealthResponse> GetAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (_cached is { } current && _expiresAt > now)
            return current;

        await _gate.WaitAsync(ct);
        try
        {
            now = time.GetUtcNow();
            if (_cached is { } afterWait && _expiresAt > now)
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

    private async Task<HealthResponse> ProbeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var probeCt = timeout.Token;

        var indexerChecks = indexers.GetEnabled()
            .Take(options.Value.Search.MaxIndexersPerSearch)
            .Select(async i =>
        {
            try
            {
                var result = await indexerTester.TestAsync(i, probeCt);
                return new ReachabilityStatus
                {
                    Name = i.Name,
                    Reachable = result.Success,
                    LatencyMs = result.LatencyMs,
                    Error = result.Success ? null : "unreachable",
                };
            }
            catch (OperationCanceledException)
            {
                return new ReachabilityStatus { Name = i.Name, Reachable = false, Error = "timed out" };
            }
            catch
            {
                return new ReachabilityStatus { Name = i.Name, Reachable = false, Error = "unreachable" };
            }
        });

        IReadOnlyList<Persistence.Entities.ProviderEntity> providerEntities;
        var providerListFailed = false;
        try
        {
            providerEntities = await providers.ListAsync(probeCt);
        }
        catch (OperationCanceledException)
        {
            providerEntities = [];
            providerListFailed = true;
        }
        catch
        {
            providerEntities = [];
            providerListFailed = true;
        }

        using var providerGate = new SemaphoreSlim(4, 4);
        var providerChecks = providerEntities.Where(p => p.Enabled).Take(32).Select(async p =>
        {
            var acquired = false;
            try
            {
                await providerGate.WaitAsync(probeCt);
                acquired = true;
                var (ok, _) = await providerTester.ProbeAsync(providers.ToProvider(p), probeCt);
                return new ReachabilityStatus { Name = p.Name, Reachable = ok, Error = ok ? null : "unreachable" };
            }
            catch (OperationCanceledException)
            {
                return new ReachabilityStatus { Name = p.Name, Reachable = false, Error = "timed out" };
            }
            catch
            {
                return new ReachabilityStatus { Name = p.Name, Reachable = false, Error = "unreachable" };
            }
            finally
            {
                if (acquired)
                    providerGate.Release();
            }
        });

        var indexerResults = await Task.WhenAll(indexerChecks);
        var providerResults = await Task.WhenAll(providerChecks);
        var allReachable = !providerListFailed && indexerResults.All(r => r.Reachable) &&
                           providerResults.All(r => r.Reachable);

        return new HealthResponse
        {
            Status = allReachable ? "ok" : "degraded",
            Version = "unknown",
            Indexers = indexerResults,
            Providers = providerResults,
        };
    }
}
