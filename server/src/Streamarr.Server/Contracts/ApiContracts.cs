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

    /// <summary>
    /// Upstream availability evidence, independent of local repair:
    /// "unknown" | "ready" | "degraded" | "dead". Additive; absent on older servers.
    /// </summary>
    public string? OriginHealth { get; init; }

    /// <summary>
    /// How the release is playable right now:
    /// "remoteReady" | "progressive" | "repairing" | "repairedReady" | "unavailable".
    /// A locally repaired release reports Status "ready" for old clients while
    /// OriginHealth stays "dead".
    /// </summary>
    public string? Playability { get; init; }

    /// <summary>PAR2 repair status for this release, when a job exists. Additive.</summary>
    public RepairStatusInfo? Repair { get; init; }
}

/// <summary>Structured repair progress attached to resolve responses and status endpoints.</summary>
public sealed record RepairStatusInfo
{
    public required string JobId { get; init; }

    /// <summary>"unknown" | "notNeeded" | "repairable" | "insufficientParity" | "unsupported" | "limitsExceeded".</summary>
    public required string Disposition { get; init; }

    /// <summary>"none" | "queued" | "planning" | "materializingSources" | "downloadingRecovery" | "reconstructing" | "verifying" | "ready" | "failed" | "cancelled" | "evicted".</summary>
    public required string State { get; init; }

    /// <summary>Coarse phase label for player-facing hints ("recovery", "verify", …).</summary>
    public string? Phase { get; init; }

    public long ProcessedBytes { get; init; }
    public long TotalBytes { get; init; }
    public int ProgressPercent { get; init; }
    public double? EtaSeconds { get; init; }

    /// <summary>Suggested delay before a client polls or retries the resolve.</summary>
    public int? RetryAfterSeconds { get; init; }

    /// <summary>True when the server would admit a progressive (repair-while-streaming) session.</summary>
    public bool ProgressiveEligible { get; init; }

    public string? FailureReason { get; init; }
}

/// <summary>One live session as listed by GET /api/v1/sessions.</summary>
public sealed record SessionResponse
{
    public required string Token { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string Title { get; init; }
    public required string FileName { get; init; }
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
    public required string RetentionPriority { get; init; }
    public string? PreDownloadJobId { get; init; }
    public string? PreDownloadKind { get; init; }
    public string? PreDownloadReason { get; init; }
    public string? PreDownloadSourceToken { get; init; }
    public string? PreDownloadState { get; init; }
    public long PreDownloadedBytes { get; init; }
    public long PreDownloadTotalBytes { get; init; }
    public double PreDownloadPercent { get; init; }
    public bool LocalCacheReady { get; init; }

    /// <summary>True while at least one HTTP stream is open over this session's file.</summary>
    public bool IsStreaming { get; init; }

    /// <summary>Probed media duration in ticks, once ffprobe has run. Null when unknown.</summary>
    public long? RunTimeTicks { get; init; }

    /// <summary>
    /// Average byte rate the media needs for realtime playback (SizeBytes / duration).
    /// Null until the duration has been probed.
    /// </summary>
    public double? RequiredBytesPerSecond { get; init; }

    /// <summary>Recent NNTP ingest rate for this session (rolling window). Null when idle.</summary>
    public double? DownloadBytesPerSecond { get; init; }

    /// <summary>Articles currently failed for this session's release (0 when untracked).</summary>
    public int FailedArticles { get; init; }

    /// <summary>Failed articles with missing-article evidence (NNTP 430), a subset of FailedArticles.</summary>
    public int MissingArticles { get; init; }

    /// <summary>Articles currently queued or downloading (0 when untracked).</summary>
    public int ActiveArticles { get; init; }

    /// <summary>Share of the release payload buffered from Usenet; 100 once fully on disk.</summary>
    public double? BufferedPercent { get; init; }

    /// <summary>Compact buffered payload intervals (fractions), for overview timeline rails.</summary>
    public IReadOnlyList<ByteRangeResponse> BufferedRanges { get; init; } = [];

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
    public required string RetentionPriority { get; init; }
    public string? PreDownloadJobId { get; init; }
    public string? PreDownloadKind { get; init; }
    public string? PreDownloadReason { get; init; }
    public string? PreDownloadSourceToken { get; init; }
    public string? PreDownloadState { get; init; }
    public long PreDownloadedBytes { get; init; }
    public long PreDownloadTotalBytes { get; init; }
    public double PreDownloadPercent { get; init; }
    public bool LocalCacheReady { get; init; }

    /// <summary>True while at least one HTTP stream is open; such files cannot be manually purged.</summary>
    public bool IsStreaming { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastAccessedAt { get; init; }
    public DateTimeOffset PurgeAt { get; init; }
}

/// <summary>Scoped query for releases with a pre-download file on Core's local disk.</summary>
public sealed record LocalReleaseAvailabilityRequest
{
    public required IReadOnlyList<string> WorkIds { get; init; }
    public required string Client { get; init; }
    public required string RequestedById { get; init; }
}

/// <summary>Up to 20 disk-backed releases per requested work, scoped to one user and client.</summary>
public sealed record LocalReleaseAvailabilityResponse
{
    public required IReadOnlyList<LocalReleaseAvailabilityEntry> Releases { get; init; }
}

/// <summary>One release whose episode-specific pre-download is running or locally complete.</summary>
public sealed record LocalReleaseAvailabilityEntry
{
    public required string WorkId { get; init; }
    public required string ReleaseId { get; init; }
    public required string State { get; init; }

    /// <summary>
    /// Current public metadata for the exact work/release registration, when it is still
    /// present in the bounded release store. <see cref="ReleaseId"/> remains available
    /// when the registration has already expired.
    /// </summary>
    public ReleaseDto? Release { get; init; }
}

/// <summary>One event in the cross-front-end streaming history.</summary>
public sealed record StreamingHistoryResponse
{
    public long Id { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public required string Title { get; init; }
    public required string Event { get; init; }
    public long PositionTicks { get; init; }
    public long DurationTicks { get; init; }
    public string? SessionToken { get; init; }
    public required string Source { get; init; }
    public string? PlaybackSessionId { get; init; }
    public string? ExternalUserId { get; init; }
    public string? ExternalUserName { get; init; }
    public string? DeviceName { get; init; }
    public DateTimeOffset ReceivedAt { get; init; }
}

/// <summary>
/// One row of the permanent stream-attempt history (BRIEF §11 console) — the last N stream
/// attempts, live or long since closed, so a report like "this release errored around 9pm"
/// can be looked up after the fact. List-view shape; omits the event timeline.
/// </summary>
public sealed record StreamRecordSummaryResponse
{
    /// <summary>The real session token when one was minted, otherwise a synthetic attempt id.</summary>
    public required string Token { get; init; }

    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public string? Title { get; init; }
    public string? ResolvedReleaseId { get; init; }
    public string? ResolvedTitle { get; init; }
    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public long NntpCommandsTotal { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? ClosedAt { get; init; }

    /// <summary>Null while open; terminal values include closed, interrupted, expired, evicted, purged, invalidated, reused, dead, and error.</summary>
    public string? FinalState { get; init; }
    public string? CloseReason { get; init; }
    public string? FailureKind { get; init; }
    public string? FailureReason { get; init; }
}

/// <summary>One stream-history record with its full, time-ordered diagnostic event log.</summary>
public sealed record StreamRecordResponse
{
    public required string Token { get; init; }
    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }
    public string? Title { get; init; }
    public string? ResolvedReleaseId { get; init; }
    public string? ResolvedTitle { get; init; }
    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long BytesServed { get; init; }
    public long NntpCommandsTotal { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? ClosedAt { get; init; }
    public string? FinalState { get; init; }
    public string? CloseReason { get; init; }
    public string? FailureKind { get; init; }
    public string? FailureReason { get; init; }

    /// <summary>Wall-clock instant of timeline t0, for aligning the flamegraph (matches SessionResponse.TimelineStartedAt).</summary>
    public DateTimeOffset? TimelineStartedAt { get; init; }

    /// <summary>Request→first-frame spans only (same shape as the live console's flamegraph).</summary>
    public IReadOnlyList<TtffSpanResponse> Timeline { get; init; } = [];

    /// <summary>Every recorded event, chronological — ttff spans, folded-in PAR2 repair transitions, session lifecycle, errors.</summary>
    public IReadOnlyList<StreamEventResponse> Events { get; init; } = [];
}

/// <summary>One chronological diagnostic log entry for a <see cref="StreamRecordResponse"/>.</summary>
public sealed record StreamEventResponse
{
    public required DateTimeOffset AtUtc { get; init; }

    /// <summary>"ttff" | "lifecycle" | "repair" | "error".</summary>
    public required string Source { get; init; }

    public required string Category { get; init; }
    public required string Name { get; init; }
    public string? Detail { get; init; }
    public double? StartMs { get; init; }
    public double? DurationMs { get; init; }
}

/// <summary>Live, bounded diagnostic snapshot of every article in a release.</summary>
public sealed record ArticleMapResponse
{
    public required string ReleaseId { get; init; }
    public int TotalArticles { get; init; }
    public int TrackedArticles { get; init; }
    public int TruncatedArticles { get; init; }
    public int PendingArticles { get; init; }
    public int ActiveArticles { get; init; }
    public int PartialArticles { get; init; }
    public int DownloadedArticles { get; init; }
    public int CachedArticles { get; init; }
    public int FailedArticles { get; init; }

    /// <summary>Failed articles with missing-article evidence (NNTP 430), a subset of FailedArticles.</summary>
    public int MissingArticles { get; init; }
    public long DownloadedBytes { get; init; }
    public double? AverageDurationMs { get; init; }
    public double? EffectiveBytesPerSecond { get; init; }

    /// <summary>Recent NNTP ingest rate over a rolling window. Null when nothing arrived recently.</summary>
    public double? RecentBytesPerSecond { get; init; }

    /// <summary>Sum of per-article expected byte weights — the denominator for the fraction ranges.</summary>
    public long TotalExpectedBytes { get; init; }

    /// <summary>Bytes currently buffered from Usenet (downloaded or cache-resident articles).</summary>
    public long BufferedBytes { get; init; }

    /// <summary>Merged payload intervals buffered from Usenet, as fractions of TotalExpectedBytes.</summary>
    public IReadOnlyList<ByteRangeResponse> BufferedRanges { get; init; } = [];

    /// <summary>Merged payload intervals actually served to the client (queried chunks).</summary>
    public IReadOnlyList<ByteRangeResponse> DeliveredRanges { get; init; } = [];
    public DateTimeOffset UpdatedAt { get; init; }
    public IReadOnlyList<ArticleTelemetryResponse> Articles { get; init; } = [];
    public IReadOnlyList<ArticleProviderSummaryResponse> Providers { get; init; } = [];
}

/// <summary>Current transfer state and diagnostic evidence for one ordered release article.</summary>
public sealed record ArticleTelemetryResponse
{
    public int Index { get; init; }
    public string? FileName { get; init; }
    public int? ArticleNumber { get; init; }
    public long ExpectedBytes { get; init; }
    public required string MessageId { get; init; }
    public required string State { get; init; }
    public long Bytes { get; init; }
    public double? DurationMs { get; init; }
    public double? ThroughputBytesPerSecond { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public string? SuccessfulProvider { get; init; }
    public string? ErrorType { get; init; }
    public string? ErrorMessage { get; init; }
    public long ProviderAttemptCount { get; init; }
    public bool AttemptsTruncated { get; init; }
    public IReadOnlyList<ArticleProviderAttemptResponse> Attempts { get; init; } = [];
}

/// <summary>One provider attempt made while retrieving an article.</summary>
public sealed record ArticleProviderAttemptResponse
{
    public required string Provider { get; init; }
    public required string Operation { get; init; }
    public required string Outcome { get; init; }
    public double DurationMs { get; init; }
    public int? ResponseCode { get; init; }
    public string? ErrorType { get; init; }
    public string? ErrorMessage { get; init; }
}

/// <summary>Aggregate provider outcomes across the release snapshot.</summary>
public sealed record ArticleProviderSummaryResponse
{
    public required string Provider { get; init; }
    public long Successes { get; init; }
    public long Missing { get; init; }
    public long Errors { get; init; }
    public double? AverageDurationMs { get; init; }

    /// <summary>Bytes credited to this provider from successful body transfers.</summary>
    public long BytesDownloaded { get; init; }

    /// <summary>Per-connection transfer rate: credited bytes over their summed transfer time.</summary>
    public double? BytesPerSecond { get; init; }
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
