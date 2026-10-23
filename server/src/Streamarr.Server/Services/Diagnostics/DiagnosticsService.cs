using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>
/// Builds the diagnostics report: the shared dependency snapshot (indexers, providers, TMDB) plus live local checks
/// (database round trip, disk space, streams and connection pools), an overall verdict and hint codes.
/// </summary>
public sealed class DiagnosticsService(
    DeepHealthDiagnostics dependencies,
    IDbContextFactory<StreamarrDbContext> dbFactory,
    PreDownloadWorkspace workspace,
    SessionManager sessions,
    MultiProviderNntpClient nntp,
    StreamarrMetrics metrics,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ServiceStatusTracker? statusTracker = null)
{
    public const double SlowProviderMs = 2_000;
    public const double SlowIndexerMs = 3_000;
    public const double SlowTmdbMs = 2_000;
    public const double SlowDatabaseMs = 500;

    private static readonly TimeSpan DatabaseTimeout = TimeSpan.FromSeconds(5);
    private static readonly DateTimeOffset StartedAt = ProcessStart();

    /// <summary>Informational version of the running server.</summary>
    public static string Version { get; } = typeof(DiagnosticsService).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

    public async Task<DiagnosticsResponse> BuildAsync(bool refresh, bool redact, CancellationToken ct)
    {
        var snapshotTask = dependencies.GetSnapshotAsync(refresh, ct);
        var database = await ProbeDatabaseAsync(ct);
        var snapshot = await snapshotTask;
        var now = time.GetUtcNow();

        var components = new List<DiagnosticsComponent> { database };
        components.Add(Tmdb(snapshot));
        components.AddRange(Providers(snapshot, redact));
        components.AddRange(Indexers(snapshot, redact));
        if (Disk(redact) is { } disk)
            components.Add(disk);
        components.Add(Streams());

        var (status, hints) = Verdict(components, snapshot);
        statusTracker?.Observe(components, snapshot);
        return new DiagnosticsResponse
        {
            Status = status,
            Hints = hints,
            Server = new DiagnosticsServer
            {
                Version = Version,
                UptimeSeconds = Math.Round(Math.Max(0, (DateTimeOffset.UtcNow - StartedAt).TotalSeconds)),
                Now = now,
            },
            Components = components,
            CheckedAt = snapshot.CheckedAt,
            AgeSeconds = Math.Round(Math.Max(0, (now - snapshot.CheckedAt).TotalSeconds), 1),
            RefreshAvailableAt = snapshot.CheckedAt + DeepHealthDiagnostics.MinRefreshInterval,
        };
    }

    private async Task<DiagnosticsComponent> ProbeDatabaseAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        string? error = null;
        var ok = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(DatabaseTimeout);
            await using var db = await dbFactory.CreateDbContextAsync(timeout.Token);
            ok = await db.Database.CanConnectAsync(timeout.Token);
            if (!ok)
                error = "The database refused the connection.";
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            error = "timed out";
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            error = e.Message;
        }
        var latency = Round(sw.Elapsed.TotalMilliseconds);
        return new DiagnosticsComponent
        {
            Id = "database",
            Kind = "database",
            Name = "Database",
            Status = !ok ? "down" : latency > SlowDatabaseMs ? "degraded" : "ok",
            LatencyMs = latency,
            ErrorCode = !ok ? error == "timed out" ? "timeout" : "unreachable" : latency > SlowDatabaseMs ? "slow" : null,
            Error = error,
        };
    }

    private static DiagnosticsComponent Tmdb(DependencySnapshot snapshot)
    {
        var probe = snapshot.Tmdb;
        var latency = snapshot.TmdbLatencyMs is { } ms ? Round(ms) : (double?)null;
        string status;
        string? code;
        if (probe is null)
            (status, code) = ("ok", null);
        else if (probe.ErrorCode == "not_configured")
            (status, code) = ("unconfigured", "not_configured");
        else if (!probe.Reachable)
            (status, code) = ("down", probe.ErrorCode ?? "unreachable");
        else if (latency > SlowTmdbMs)
            (status, code) = ("degraded", "slow");
        else
            (status, code) = ("ok", null);

        return new DiagnosticsComponent
        {
            Id = "metadata",
            Kind = "metadata",
            Name = "TMDB",
            Status = status,
            LatencyMs = latency,
            ErrorCode = code,
            Error = probe?.Error,
            Detail = probe is null ? "This server's metadata client does not support a reachability check." : null,
        };
    }

    private IEnumerable<DiagnosticsComponent> Providers(DependencySnapshot snapshot, bool redact)
    {
        var pools = nntp.Providers;
        var index = 0;
        foreach (var probe in snapshot.Providers)
        {
            index++;
            var pool = pools.FirstOrDefault(p => string.Equals(p.ProviderName, probe.Name, StringComparison.Ordinal));
            var latency = probe.LatencyMs is { } ms ? Round(ms) : (double?)null;
            var (status, code) = !probe.Reachable
                ? ("down", probe.ErrorCode ?? "unreachable")
                : pool is { IsTripped: true } ? ("degraded", "circuit_open")
                : latency > SlowProviderMs ? ("degraded", "slow")
                : ("ok", (string?)null);
            yield return new DiagnosticsComponent
            {
                Id = $"provider:{index}",
                Kind = "provider",
                Name = redact ? $"Provider {index}" : probe.Name,
                Status = status,
                LatencyMs = latency,
                ErrorCode = code,
                Error = redact ? null : probe.Error,
                Detail = redact ? null : string.Create(CultureInfo.InvariantCulture, $"priority {probe.Priority ?? 0}"),
                ConnectionsInUse = pool?.ActiveConnections,
                ConnectionsMax = pool is null ? null : pool.ActiveConnections + pool.AvailableConnections,
            };
        }
    }

    private IEnumerable<DiagnosticsComponent> Indexers(DependencySnapshot snapshot, bool redact)
    {
        var history = metrics.IndexerLatencies().ToDictionary(i => i.Id, StringComparer.Ordinal);
        var index = 0;
        foreach (var probe in snapshot.Indexers)
        {
            index++;
            var latency = probe.LatencyMs is { } ms ? Round(ms) : (double?)null;
            var (status, code) = !probe.Reachable
                ? ("down", probe.ErrorCode ?? "unreachable")
                : latency > SlowIndexerMs ? ("degraded", "slow")
                : ("ok", (string?)null);
            string? detail = null;
            if (!redact && history.TryGetValue(probe.Id, out var seen) && seen.Requests > 0)
            {
                detail = string.Create(CultureInfo.InvariantCulture,
                    $"searches: {seen.Requests}, failed: {seen.Failures}, average {Math.Round(seen.AvgLatencyMs)} ms");
            }
            yield return new DiagnosticsComponent
            {
                Id = $"indexer:{index}",
                Kind = "indexer",
                Name = redact ? $"Indexer {index}" : probe.Name,
                Status = status,
                LatencyMs = latency,
                ErrorCode = code,
                Error = redact ? null : probe.Error,
                Detail = detail,
            };
        }
    }

    private DiagnosticsComponent? Disk(bool redact)
    {
        var (_, free) = StorageController.MeasureDisk(workspace.Root);
        if (free is not { } freeBytes)
            return null;
        var minimum = options.Value.PreDownload.MinimumFreeDiskBytes;
        var low = freeBytes < minimum;
        return new DiagnosticsComponent
        {
            Id = "disk",
            Kind = "disk",
            Name = "Storage",
            Status = low ? "degraded" : "ok",
            ErrorCode = low ? "low_space" : null,
            FreeBytes = redact ? null : freeBytes,
            MinimumFreeBytes = redact ? null : minimum,
        };
    }

    private DiagnosticsComponent Streams()
    {
        var budget = Math.Max(1, options.Value.ConnectionBudget);
        var inUse = sessions.NntpConnectionsInUse;
        var exhausted = inUse >= budget;
        return new DiagnosticsComponent
        {
            Id = "streams",
            Kind = "streams",
            Name = "Streams",
            Status = exhausted ? "degraded" : "ok",
            ErrorCode = exhausted ? "exhausted" : null,
            ActiveStreams = sessions.ListSessions().Count,
            ConnectionsInUse = inUse,
            ConnectionsMax = budget,
        };
    }

    internal static (string Status, IReadOnlyList<string> Hints) Verdict(
        IReadOnlyList<DiagnosticsComponent> components,
        DependencySnapshot snapshot)
    {
        var hints = new List<string>();
        var down = false;

        var database = components.FirstOrDefault(c => c.Kind == "database");
        if (database is { Status: "down" })
        {
            hints.Add("database_unreachable");
            down = true;
        }

        var providers = components.Where(c => c.Kind == "provider").ToList();
        if (providers.Count == 0)
        {
            hints.Add(snapshot.ProviderListFailed ? "database_unreachable" : "no_providers");
            down = true;
        }
        else if (providers.All(p => p.Status == "down"))
        {
            hints.Add("all_providers_down");
            down = true;
        }
        if (providers.Any(p => p.ErrorCode == "auth_failed"))
            hints.Add("provider_auth_failed");
        if (providers.Any(p => p.Status == "down") && !providers.All(p => p.Status == "down"))
            hints.Add("some_providers_down");
        if (providers.Any(p => p.ErrorCode is "slow" or "circuit_open"))
            hints.Add("provider_slow");

        var indexers = components.Where(c => c.Kind == "indexer").ToList();
        if (indexers.Count == 0)
        {
            hints.Add("no_indexers");
            down = true;
        }
        else if (indexers.All(i => i.Status == "down"))
        {
            hints.Add("all_indexers_down");
            down = true;
        }
        if (indexers.Any(i => i.ErrorCode == "auth_failed"))
            hints.Add("indexer_auth_failed");
        if (indexers.Any(i => i.Status == "down") && !indexers.All(i => i.Status == "down"))
            hints.Add("some_indexers_down");
        if (indexers.Any(i => i.ErrorCode == "slow"))
            hints.Add("indexer_slow");

        var tmdb = components.FirstOrDefault(c => c.Kind == "metadata");
        if (tmdb is { Status: "down" })
            hints.Add("tmdb_unreachable");
        else if (tmdb is { Status: "unconfigured" })
            hints.Add("tmdb_not_configured");
        else if (tmdb is { ErrorCode: "slow" })
            hints.Add("tmdb_slow");

        if (components.Any(c => c is { Kind: "disk", ErrorCode: "low_space" }))
            hints.Add("disk_low");
        if (components.Any(c => c is { Kind: "streams", ErrorCode: "exhausted" }))
            hints.Add("connections_exhausted");

        var distinct = hints.Distinct(StringComparer.Ordinal).ToList();
        var status = down ? "down" : distinct.Count > 0 || components.Any(c => c.Status != "ok") ? "degraded" : "ok";
        return (status, distinct);
    }

    private static double Round(double ms) => Math.Round(ms, 1);

    private static DateTimeOffset ProcessStart()
    {
        try
        {
            return new DateTimeOffset(Process.GetCurrentProcess().StartTime.ToUniversalTime(), TimeSpan.Zero);
        }
        catch (Exception e) when (e is InvalidOperationException or NotSupportedException or System.ComponentModel.Win32Exception)
        {
            return DateTimeOffset.UtcNow;
        }
    }
}
