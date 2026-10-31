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

/// <summary>
/// Viewer service status (GET /api/v1/viewer/diagnostics/status): a cheap summary of the last shared check for an in-app
/// banner. Categories and impact codes only; never names, hosts or error texts.
/// </summary>
public sealed record ServiceStatusResponse
{
    /// <summary><c>ok</c>, <c>degraded</c> (something is partly failing or slow) or <c>down</c> (search, Usenet or the server itself cannot work).</summary>
    public required string State { get; init; }

    /// <summary>Always the four categories in this order: <c>search</c> (indexers), <c>usenet</c> (providers), <c>metadata</c> (TMDB), <c>server</c> (database, storage, stream slots).</summary>
    public required IReadOnlyList<ServiceStatusCategory> Categories { get; init; }

    /// <summary>What viewers notice, most severe first: <c>playbackUnavailable</c>, <c>searchUnavailable</c>, <c>playbackMayFail</c>, <c>searchMayBeIncomplete</c>, <c>newTitlesUnavailable</c>, <c>slowerThanUsual</c>.</summary>
    public required IReadOnlyList<string> Impacts { get; init; }

    /// <summary>When the current problem started (first check that was not <c>ok</c>); null while everything is ok.</summary>
    public DateTimeOffset? Since { get; init; }

    /// <summary>When the shared dependency check behind this status ran.</summary>
    public required DateTimeOffset CheckedAt { get; init; }

    /// <summary>Whether the operator gets a notification about outages automatically (Pushover enabled and configured with the service status event).</summary>
    public required bool AdminNotified { get; init; }
}

public sealed record ServiceStatusCategory
{
    /// <summary><c>search</c>, <c>usenet</c>, <c>metadata</c> or <c>server</c>.</summary>
    public required string Id { get; init; }

    /// <summary><c>ok</c>, <c>degraded</c> or <c>down</c>.</summary>
    public required string State { get; init; }

    /// <summary>When this category stopped being <c>ok</c>; null while ok.</summary>
    public DateTimeOffset? Since { get; init; }

    /// <summary>Checked parts of this category that are not ok (e.g. 1 of 3 indexers).</summary>
    public required int Affected { get; init; }

    public required int Total { get; init; }
}

/// <summary>
/// A server ↔ Usenet speed test (POST/GET /api/v1/diagnostics/usenet-speed for admins, /api/v1/viewer/diagnostics/usenet-speed
/// redacted for viewers: providers by number and role only, codes but no names, hosts or error texts).
/// </summary>
public sealed record UsenetSpeedTestResponse
{
    /// <summary><c>ok</c> or <c>failed</c> (every tried provider failed; see <see cref="Code"/>).</summary>
    public required string Status { get; init; }

    /// <summary>Why it failed: the last provider's code (<c>connect_failed</c>, <c>auth_failed</c>, <c>no_article</c>, <c>timeout</c>, <c>no_data</c>, <c>no_free_connections</c>, <c>error</c>) or <c>no_providers</c>; null when ok.</summary>
    public string? Code { get; init; }

    public required DateTimeOffset MeasuredAt { get; init; }

    /// <summary>Payload throughput from the provider to this server; null unless ok.</summary>
    public double? MegabitsPerSecond { get; init; }

    /// <summary>The measured provider (or the last one tried when the test failed).</summary>
    public UsenetSpeedProviderDto? Provider { get; init; }

    /// <summary>True when the primary failed and a later provider was measured (or tried).</summary>
    public bool FallbackUsed { get; init; }

    /// <summary>Every provider tried, in order, with its outcome code (<c>ok</c> for the measured one).</summary>
    public IReadOnlyList<UsenetSpeedProviderDto> Attempts { get; init; } = [];

    public int ConnectionsUsed { get; init; }

    /// <summary>The provider's configured connection limit.</summary>
    public int ConnectionsMax { get; init; }

    /// <summary>Streams that were playing during the test; above 0 the line was shared and the result is a lower bound.</summary>
    public int ActiveStreams { get; init; }

    public long BytesDownloaded { get; init; }
    public int DurationMs { get; init; }
    public int FirstByteMs { get; init; }

    /// <summary>Where the test articles came from: <c>recent-stream</c>, <c>recent-nzb</c> or <c>newsgroup</c>; null when none was found.</summary>
    public string? ArticleSource { get; init; }

    /// <summary>True when this answer is the shared result of a recent test (no new test ran).</summary>
    public bool Reused { get; init; }

    /// <summary>True when this caller joined a test another caller had started.</summary>
    public bool Joined { get; init; }

    /// <summary>Until then a run request returns this result instead of testing again.</summary>
    public required DateTimeOffset FreshUntil { get; init; }
}

public sealed record UsenetSpeedProviderDto
{
    /// <summary>1-based place in the provider order (priority).</summary>
    public required int Index { get; init; }

    /// <summary><c>primary</c> (first in the order) or <c>backup</c>.</summary>
    public required string Role { get; init; }

    /// <summary>Provider name; admins only.</summary>
    public string? Name { get; init; }

    /// <summary><c>ok</c> or the failure code.</summary>
    public required string Code { get; init; }

    /// <summary>The error text; admins only.</summary>
    public string? Error { get; init; }
}

/// <summary>The latest server ↔ Usenet result and whether a test is running (GET .../usenet-speed).</summary>
public sealed record UsenetSpeedTestStateResponse
{
    public required bool Running { get; init; }

    /// <summary>Whether this caller may start a test (viewers: the <c>allowUsenetSpeedTest</c> permission; admins always).</summary>
    public required bool Allowed { get; init; }

    /// <summary>The last finished test (ok or failed), however old; null when none ran since the server started.</summary>
    public UsenetSpeedTestResponse? Latest { get; init; }
}
