namespace Streamarr.Server.Contracts;

/// <summary>
/// Server diagnostics (GET /api/v1/diagnostics for admins, GET /api/v1/viewer/diagnostics redacted for viewers):
/// an overall verdict, hint codes that point at the likely cause, and one entry per checked component.
/// </summary>
public sealed record DiagnosticsResponse
{
    /// <summary><c>ok</c>, <c>degraded</c> (something is slow or partly failing) or <c>down</c> (playback or search cannot work).</summary>
    public required string Status { get; init; }

    /// <summary>Stable hint codes, most severe first: <c>database_unreachable</c>, <c>no_providers</c>, <c>all_providers_down</c>, <c>provider_auth_failed</c>, <c>some_providers_down</c>, <c>provider_slow</c>, <c>no_indexers</c>, <c>all_indexers_down</c>, <c>indexer_auth_failed</c>, <c>some_indexers_down</c>, <c>indexer_slow</c>, <c>tmdb_unreachable</c>, <c>tmdb_not_configured</c>, <c>tmdb_slow</c>, <c>disk_low</c>, <c>connections_exhausted</c>.</summary>
    public required IReadOnlyList<string> Hints { get; init; }

    public required DiagnosticsServer Server { get; init; }

    /// <summary>Checked components in display order: database, metadata, providers, indexers, disk, streams.</summary>
    public required IReadOnlyList<DiagnosticsComponent> Components { get; init; }

    /// <summary>When the dependency probes ran (results are shared and cached for a short time).</summary>
    public required DateTimeOffset CheckedAt { get; init; }

    /// <summary>Seconds since <see cref="CheckedAt"/>.</summary>
    public required double AgeSeconds { get; init; }

    /// <summary>Earliest time a <c>refresh=true</c> request runs the probes again.</summary>
    public required DateTimeOffset RefreshAvailableAt { get; init; }
}

public sealed record DiagnosticsServer
{
    public required string Version { get; init; }
    public required double UptimeSeconds { get; init; }
    public required DateTimeOffset Now { get; init; }
}

/// <summary>One checked component. Viewers get generic names ("Indexer 1") and no <c>error</c>/<c>detail</c> text.</summary>
public sealed record DiagnosticsComponent
{
    /// <summary>Stable key within one response, e.g. <c>database</c>, <c>indexer:1</c>, <c>provider:2</c>.</summary>
    public required string Id { get; init; }

    /// <summary><c>database</c>, <c>metadata</c>, <c>provider</c>, <c>indexer</c>, <c>disk</c> or <c>streams</c>.</summary>
    public required string Kind { get; init; }

    /// <summary>Configured name (admins) or a generic label such as "Indexer 1" (viewers).</summary>
    public required string Name { get; init; }

    /// <summary><c>ok</c>, <c>degraded</c>, <c>down</c> or <c>unconfigured</c>.</summary>
    public required string Status { get; init; }

    /// <summary>Round trip of the probe in milliseconds, when one was made.</summary>
    public double? LatencyMs { get; init; }

    /// <summary>Machine-readable failure class: <c>timeout</c>, <c>auth_failed</c>, <c>unreachable</c>, <c>http_error</c>, <c>invalid_response</c>, <c>not_configured</c>, <c>slow</c>, <c>low_space</c>, <c>exhausted</c>, <c>circuit_open</c>.</summary>
    public string? ErrorCode { get; init; }

    /// <summary>Admin only: the underlying error message.</summary>
    public string? Error { get; init; }

    /// <summary>Admin only: extra context (priority, average latency, request counts).</summary>
    public string? Detail { get; init; }

    /// <summary>Disk: free bytes on the cache volume.</summary>
    public long? FreeBytes { get; init; }

    /// <summary>Disk: configured free-space floor.</summary>
    public long? MinimumFreeBytes { get; init; }

    /// <summary>Provider: connections in use / pool size; streams: NNTP connections in use / global budget.</summary>
    public int? ConnectionsInUse { get; init; }

    public int? ConnectionsMax { get; init; }

    /// <summary>Streams: active streaming sessions.</summary>
    public int? ActiveStreams { get; init; }
}

/// <summary>Speed test ping (GET …/diagnostics/ping).</summary>
public sealed record SpeedTestPingResponse
{
    public required DateTimeOffset ServerTime { get; init; }

    /// <summary>Largest accepted <c>bytes</c> for the download test.</summary>
    public required long MaxDownloadBytes { get; init; }

    /// <summary>Largest accepted upload body.</summary>
    public required long MaxUploadBytes { get; init; }

    /// <summary>Parallel transfers one caller may run at once.</summary>
    public required int MaxParallelTransfers { get; init; }
}

/// <summary>Result of an upload speed test (POST …/diagnostics/speed/upload).</summary>
public sealed record SpeedTestUploadResponse
{
    public required long Bytes { get; init; }

    /// <summary>Server-side time from the first body read to the last byte.</summary>
    public required double DurationMs { get; init; }
}
