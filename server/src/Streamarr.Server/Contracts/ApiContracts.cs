namespace Streamarr.Server.Contracts;

/// <summary>Request body of POST /api/v1/resolve (BRIEF §6.2).</summary>
public sealed record ResolveRequest
{
    public required string ReleaseId { get; init; }

    /// <summary>
    /// Work that offered the release. Required to disambiguate releases spanning multiple
    /// episodes; omitted by legacy clients whose release ids have a single owner.
    /// </summary>
    public string? WorkId { get; init; }

    /// <summary>Originating front-end ("jellyfin", "web", …) for session attribution.</summary>
    public string? Client { get; init; }

    /// <summary>Stable account id in the originating front-end.</summary>
    public string? RequestedById { get; init; }

    /// <summary>Display name in the originating front-end.</summary>
    public string? RequestedByName { get; init; }

    /// <summary>
    /// When true (the default), a release that resolves dead transparently retries the
    /// next-best release of the same work, bounded, and returns the first healthy one
    /// (BRIEF §10-M7). Set false to get the raw classification of exactly this release
    /// plus a <see cref="ResolveResponse.SuggestedFallbackReleaseId"/> for manual retry.
    /// </summary>
    public bool AutoFallback { get; init; } = true;
}

/// <summary>One release the resolve pipeline attempted, with its health classification.</summary>
public sealed record ResolveAttempt
{
    public required string ReleaseId { get; init; }

    /// <summary>"ready" | "degraded" | "dead".</summary>
    public required string Status { get; init; }
}

/// <summary>
/// Neutral media stream shape — deliberately NOT Jellyfin's MediaStream schema
/// (BRIEF §6.2): the plugin maps this onto Jellyfin's model, other front-ends
/// consume it as-is.
/// </summary>
public sealed record MediaStreamInfo
{
    /// <summary>"Video", "Audio" or "Subtitle".</summary>
    public required string Type { get; init; }

    public string? Codec { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public int? Channels { get; init; }
    public string? Language { get; init; }
}

/// <summary>Response of POST /api/v1/resolve — the exact shape from BRIEF §6.2.</summary>
public sealed record ResolveResponse
{
    public required string ReleaseId { get; init; }

    /// <summary>"ready" | "degraded" | "dead".</summary>
    public required string Status { get; init; }

    /// <summary>Same-origin relative capability path; null when the release is dead.</summary>
    public string? StreamUrl { get; init; }

    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long? RunTimeTicks { get; init; }
    public IReadOnlyList<MediaStreamInfo> MediaStreams { get; init; } = [];
    public int SessionTtlSeconds { get; init; }

    /// <summary>
    /// Next-best release of the same work. Set when the resolved release is dead and
    /// auto-fallback is disabled (or exhausted), so a front-end can still retry manually.
    /// </summary>
    public string? SuggestedFallbackReleaseId { get; init; }

    /// <summary>
    /// When this response is the result of auto-fallback, the release originally
    /// requested (which resolved dead). Null when the requested release resolved directly.
    /// </summary>
    public string? FallbackFromReleaseId { get; init; }

    /// <summary>
    /// The chain of releases the resolve pipeline tried, in order, each with its health
    /// classification — so a front-end can surface exactly what happened (BRIEF §10-M7).
    /// </summary>
    public IReadOnlyList<ResolveAttempt> Attempts { get; init; } = [];
}

/// <summary>One live session as listed by GET /api/v1/sessions.</summary>
public sealed record SessionResponse
{
    public required string Token { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string State { get; init; }
    public string? Container { get; init; }
    public long SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public int NntpConnectionsInFlight { get; init; }
    public long NntpCommandsTotal { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastAccessedAt { get; init; }
    public DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Wall-clock instant of timeline t0 (resolve start), for aligning client spans.</summary>
    public DateTimeOffset? TimelineStartedAt { get; init; }

    /// <summary>Request→first-frame spans for the flamegraph on the stream page (may be empty).</summary>
    public IReadOnlyList<TtffSpanResponse> Timeline { get; init; } = [];
}

/// <summary>One measured stage on the request→first-frame timeline (flamegraph on the stream page).</summary>
public sealed record TtffSpanResponse
{
    public required string Name { get; init; }
    public required string Category { get; init; }
    public required double StartMs { get; init; }
    public required double DurationMs { get; init; }
    public string? Detail { get; init; }
    public string Source { get; init; } = "server";
}

/// <summary>
/// Client-observed spans (e.g. Jellyfin's PlaybackInfo→first delivered frame) POSTed back to
/// Core so the flamegraph spans both processes. Offsets are ms from the session's timeline t0.
/// </summary>
public sealed record ClientTimelineRequest
{
    public IReadOnlyList<ClientSpan> Spans { get; init; } = [];
}

public sealed record ClientSpan
{
    public required string Name { get; init; }
    public string? Category { get; init; }
    public required double StartMs { get; init; }
    public required double DurationMs { get; init; }
    public string? Detail { get; init; }
}

/// <summary>One release whose source NZB is available from Core's persistent cache.</summary>
public sealed record CachedReleaseResponse
{
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string Title { get; init; }
    public required string Indexer { get; init; }
    public long ReleaseSizeBytes { get; init; }
    public long NzbSizeBytes { get; init; }
    public int FileCount { get; init; }
    public int SegmentCount { get; init; }
    public long HitCount { get; init; }
    public DateTimeOffset CachedAt { get; init; }
    public DateTimeOffset LastAccessedAt { get; init; }
}

/// <summary>
/// Operational view of one server-managed ephemeral file. SizeBytes counts toward the logical
/// LRU budget, while StorageBytes reports the currently resident decoded-article footprint.
/// </summary>
public sealed record EphemeralFileResponse
{
    public required string Token { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string Title { get; init; }
    public required string FileName { get; init; }
    public required string State { get; init; }
    public string? Container { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
    public long SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public int ChunksQueried { get; init; }
    public int TotalChunks { get; init; }
    public double EstimatedStreamedPercent { get; init; }
    public int CachedChunks { get; init; }
    public long StorageBytes { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastAccessedAt { get; init; }
    public DateTimeOffset PurgeAt { get; init; }
}

/// <summary>One event in the cross-front-end streaming history.</summary>
public sealed record StreamingHistoryResponse
{
    public long Id { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string Event { get; init; }
    public long PositionTicks { get; init; }
    public required string Source { get; init; }
    public string? PlaybackSessionId { get; init; }
    public string? ExternalUserId { get; init; }
    public string? ExternalUserName { get; init; }
    public string? DeviceName { get; init; }
    public DateTimeOffset ReceivedAt { get; init; }
}

/// <summary>Typed error envelope rendered consistently by every endpoint.</summary>
public sealed record ErrorResponse
{
    public required ErrorDetail Error { get; init; }

    public static ErrorResponse Of(string code, string message)
        => new() { Error = new ErrorDetail { Code = code, Message = message } };

    /// <summary>
    /// A "download host not allowed" error carrying the offending host and owning indexer,
    /// so a front-end can offer to add the host to the indexer's allowed download hosts.
    /// </summary>
    public static ErrorResponse OfHostNotAllowed(string code, string message, string host, string indexerId)
        => new() { Error = new ErrorDetail { Code = code, Message = message, Host = host, IndexerId = indexerId } };
}

public sealed record ErrorDetail
{
    public required string Code { get; init; }
    public required string Message { get; init; }

    /// <summary>Populated only for the <c>nzb_host_not_allowed</c> error: the rejected download host.</summary>
    public string? Host { get; init; }

    /// <summary>Populated only for the <c>nzb_host_not_allowed</c> error: the owning indexer's id.</summary>
    public string? IndexerId { get; init; }
}
