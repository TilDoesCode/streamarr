using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Core.Sessions;
using Streamarr.Server.Logging;
using Streamarr.Server.Options;
using Streamarr.Server.Services.Repair;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Services;

public enum EphemeralRetentionPriority
{
    Background,
    Normal,
}

/// <summary>
/// One live streaming session (BRIEF §6.1 module 6): the resolved media file,
/// a per-session NNTP client metering usage against the shared global budget,
/// and deterministic ephemeral-cache bookkeeping.
/// </summary>
public sealed class ActiveSession
{
    private long _bytesServed;
    private long _runTimeTicks;
    private int _openStreamCount;
    private int _closed;
    private int _initialMediaByteRecorded;
    private int _retentionPriority;
    private readonly CancellationTokenSource _lifetimeCancellation = new();
    private readonly TaskCompletionSource<bool> _openingCompleted = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _lifecycleGate = new();
    private readonly StreamarrMetrics? _metrics;
    private readonly SegmentCache? _segmentCache;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, byte> _queriedChunks = new(StringComparer.Ordinal);

    internal ActiveSession(
        StreamSession session,
        ResolvedMediaFile file,
        INntpClient nntpClient,
        CountingNntpGate nntpUsage,
        StreamarrMetrics? metrics = null,
        SegmentCache? segmentCache = null,
        ArticleDownloadTracker? articleTracker = null,
        string? title = null,
        TimeProvider? time = null,
        string status = "ready",
        bool opening = false,
        EphemeralRetentionPriority retentionPriority = EphemeralRetentionPriority.Normal)
    {
        Session = session;
        File = file;
        NntpClient = nntpClient;
        NntpUsage = nntpUsage;
        ContentType = ContainerContentTypes.For(file.Container);
        _metrics = metrics;
        _segmentCache = segmentCache;
        ArticleTracker = articleTracker;
        _time = time ?? TimeProvider.System;
        Title = string.IsNullOrWhiteSpace(title) ? file.FileName : title;
        Status = status;
        _retentionPriority = (int)retentionPriority;
        if (!opening)
            _openingCompleted.TrySetResult(true);
    }

    public StreamSession Session { get; }
    public ResolvedMediaFile File { get; }
    public INntpClient NntpClient { get; }
    public CountingNntpGate NntpUsage { get; }
    public ArticleDownloadTracker? ArticleTracker { get; internal set; }
    public string ContentType { get; }
    public string Title { get; }
    public string Status { get; }
    public FfprobeResult? Probe { get; private set; }
    public PreDownloadCacheFile? PreDownloadCache { get; private set; }
    public string? PreDownloadJobId { get; private set; }
    public string? PreDownloadKind { get; private set; }
    public string? PreDownloadReason { get; private set; }
    public string? PreDownloadSourceToken { get; private set; }
    public EphemeralRetentionPriority RetentionPriority
        => (EphemeralRetentionPriority)Volatile.Read(ref _retentionPriority);
    public long RunTimeTicks => Volatile.Read(ref _runTimeTicks);

    /// <summary>
    /// Request→first-frame timing for this playback attempt (BRIEF §11 diagnostics). Populated
    /// during resolve, extended by the stream first-byte and by client-reported spans, and
    /// rendered as a flamegraph on the stream page. Null when diagnostics are unavailable.
    /// </summary>
    public TtffTimeline? Timeline { get; internal set; }

    /// <summary>
    /// Links this session back to its permanent <c>StreamRecord</c> history row (BRIEF §11
    /// console), when history tracking is enabled. Null for sessions created without a
    /// tracked resolve attempt (e.g. some test construction paths).
    /// </summary>
    public string? StreamAttemptId { get; internal set; }

    public string Token => Session.Token;
    public long BytesServed => Interlocked.Read(ref _bytesServed);
    // SessionStream checks this for every body read. Keep the playback hot path lock-free; the
    // lifecycle gate is still used where open/close admission must be serialized.
    public bool IsClosed => Volatile.Read(ref _closed) != 0;
    internal CancellationToken LifetimeToken => _lifetimeCancellation.Token;

    internal bool TryRecordInitialMediaByte()
        => Interlocked.Exchange(ref _initialMediaByteRecorded, 1) == 0;

    /// <summary>
    /// True while at least one HTTP stream is open over this file. A manual purge refuses to
    /// evict an actively streamed file so in-flight playback is never torn out from under a
    /// client; the hard-TTL sweep and LRU eviction are deliberately not subject to this guard.
    /// </summary>
    public bool IsStreaming
    {
        get
        {
            lock (_lifecycleGate)
                return _openStreamCount > 0;
        }
    }

    public bool IsPreDownloading
        => PreDownloadCache is { IsComplete: false } cache
           && !cache.IsCancelled;

    public DateTimeOffset ExpiresAt
    {
        get
        {
            lock (_lifecycleGate)
                return Session.ExpiresAt;
        }
    }
    public int ChunksQueried => _queriedChunks.Count;

    /// <summary>Segment ids the client actually pulled through this session (for delivered ranges).</summary>
    public IEnumerable<string> QueriedChunkIds => _queriedChunks.Keys;
    public double EstimatedStreamedPercent => File.SegmentIds.Count == 0
        ? 0
        : Math.Min(100, ChunksQueried * 100d / File.SegmentIds.Count);
    public (int Count, long Bytes) CachedStorage => _segmentCache?.GetStats(File.SegmentIds) ?? (0, 0);

    // Deliberately lock-free: this runs after every body read. A concurrent close may leave a
    // newer diagnostic timestamp on a closed session, which is harmless; admission stays gated.
    public void Touch() => Session.LastAccessedAt = _time.GetUtcNow();

    internal bool TryOpenStream(Func<Stream> openStream, out Stream? stream)
    {
        ArgumentNullException.ThrowIfNull(openStream);
        lock (_lifecycleGate)
        {
            if (_closed != 0 || Session.ExpiresAt <= _time.GetUtcNow())
            {
                stream = null;
                return false;
            }

            Session.LastAccessedAt = _time.GetUtcNow();
            stream = openStream();
            _openStreamCount++;
            return true;
        }
    }

    internal void EndStream()
    {
        lock (_lifecycleGate)
        {
            if (_openStreamCount > 0)
                _openStreamCount--;
            if (_closed == 0)
                Session.LastAccessedAt = _time.GetUtcNow();
        }
    }

    internal bool IsExpired(DateTimeOffset now)
    {
        lock (_lifecycleGate)
            return _closed != 0 || Session.ExpiresAt <= now;
    }

    internal void RecordChunkRequested(string segmentId) => _queriedChunks.TryAdd(segmentId, 0);

    internal void RecordTransferEvent(SegmentTransferEvent transfer)
    {
        var tracker = ArticleTracker;
        if (tracker is null)
            return;

        switch (transfer.Stage)
        {
            case SegmentTransferStage.Queued:
                tracker.MarkQueued(transfer.SegmentId);
                break;
            case SegmentTransferStage.Downloading:
                tracker.MarkDownloading(
                    transfer.SegmentId,
                    bytes: transfer.Bytes,
                    durationMs: transfer.DurationMs);
                break;
            case SegmentTransferStage.Cached:
                tracker.MarkCached(transfer.SegmentId, transfer.Bytes, transfer.DurationMs);
                break;
            case SegmentTransferStage.Downloaded:
                tracker.MarkDownloaded(transfer.SegmentId, transfer.Bytes, transfer.DurationMs);
                break;
            case SegmentTransferStage.Partial:
                tracker.MarkPartial(
                    transfer.SegmentId,
                    transfer.Bytes,
                    durationMs: transfer.DurationMs);
                break;
            case SegmentTransferStage.Failed:
                tracker.MarkFailed(
                    transfer.SegmentId,
                    transfer.ErrorType,
                    transfer.ErrorMessage,
                    transfer.Bytes,
                    transfer.DurationMs);
                break;
        }
    }

    internal void AddBytesServed(long count)
    {
        Session.BytesServed = Interlocked.Add(ref _bytesServed, count);
        _metrics?.AddBytesServed(count);
    }

    /// <summary>
    /// Supplies the probed duration after resolve's loopback ffprobe has completed. The session
    /// must exist before that probe can read it, so duration cannot be provided at construction.
    /// External playback URLs are not returned until after this value has been set.
    /// </summary>
    internal void SetRunTimeTicks(long? runTimeTicks)
        => Volatile.Write(ref _runTimeTicks, runTimeTicks is > 0 ? runTimeTicks.Value : 0);

    internal void SetRetentionPriority(EphemeralRetentionPriority priority)
    {
        lock (_lifecycleGate)
            Interlocked.Exchange(ref _retentionPriority, (int)priority);
    }

    internal void PromoteRetention()
        => SetRetentionPriority(EphemeralRetentionPriority.Normal);

    internal bool AttachPreDownload(
        PreDownloadCacheFile cache,
        string jobId,
        string kind,
        string reason,
        string? sourceToken)
    {
        lock (_lifecycleGate)
        {
            if (_closed != 0 || PreDownloadCache is not null)
                return false;
            PreDownloadCache = cache;
            PreDownloadJobId = jobId;
            PreDownloadKind = kind;
            PreDownloadReason = reason;
            PreDownloadSourceToken = sourceToken;
            return true;
        }
    }

    internal double GetPacingSustainBytesPerSecond(double configuredFloor)
        => StreamPacer.SelectSustainBytesPerSecond(
            File.SizeBytes,
            Volatile.Read(ref _runTimeTicks),
            configuredFloor);

    /// <summary>
    /// Resolves can share an already-admitted release while its first ffprobe is still running.
    /// Waiting callers receive the same capability only after its response metadata is complete.
    /// </summary>
    internal Task<bool> WaitUntilReadyAsync(CancellationToken ct)
        => _openingCompleted.Task.WaitAsync(ct);

    internal bool CompleteOpening(FfprobeResult? probe)
    {
        lock (_lifecycleGate)
        {
            if (_closed != 0)
                return false;

            Probe = probe;
            Session.State = SessionState.Ready;
            _openingCompleted.TrySetResult(true);
            return true;
        }
    }

    internal void MarkClosed()
    {
        lock (_lifecycleGate)
        {
            Volatile.Write(ref _closed, 1);
            Session.State = SessionState.Closed;
        }
        _lifetimeCancellation.Cancel();
        PreDownloadCache?.Dispose();
        _openingCompleted.TrySetResult(false);
    }

    /// <summary>
    /// Atomically closes the file only when no HTTP stream is open. Shares the lifecycle gate
    /// with <see cref="TryOpenStream"/>, so a stream that opens concurrently is either admitted
    /// before the purge (and observed here) or refused afterwards — the guard can never race a
    /// stream open. Returns false when the file is being streamed or is already closed.
    /// </summary>
    internal bool TryPurgeIfIdle(EphemeralRetentionPriority? requiredPriority = null)
    {
        lock (_lifecycleGate)
        {
            if (_closed != 0
                || _openStreamCount > 0
                || (requiredPriority is { } required && RetentionPriority != required))
                return false;

            Volatile.Write(ref _closed, 1);
            Session.State = SessionState.Closed;
        }
        _lifetimeCancellation.Cancel();
        PreDownloadCache?.Dispose();
        _openingCompleted.TrySetResult(false);
        return true;
    }
}

public readonly record struct SessionAdmission(ActiveSession Session, bool Created);

public readonly record struct LocalReleaseAvailability(string WorkId, string ReleaseId, string State);

/// <summary>Result of a manual ephemeral-file purge request.</summary>
public enum PurgeOutcome
{
    /// <summary>No live ephemeral file exists for the supplied token.</summary>
    NotFound,

    /// <summary>The file is being actively streamed and was left in place.</summary>
    Streaming,

    /// <summary>The idle file was purged from the cache.</summary>
    Purged,
}

internal sealed record SupersededSession(
    string Token,
    string ReleaseId,
    string? PreDownloadJobId,
    long PreDownloadedBytes);

/// <summary>
/// Owns the resolve → stream → close lifecycle: issues opaque unguessable stream
/// tokens, opens per-request streams over a session's media file, and owns the
/// deterministic ephemeral-file cache. Files are evicted whole in LRU order when a
/// new admission would exceed the logical byte budget, while one oversized file may
/// stand alone. A hard creation-based TTL expires files regardless of later access.
/// All sessions share one budgeted NNTP client, so the global connection budget
/// holds across concurrent sessions.
/// </summary>
public sealed class SessionManager(
    INntpClient nntpClient,
    IOptions<StreamarrOptions> options,
    ILogger<SessionManager> logger,
    StreamarrMetrics? metrics = null,
    SegmentCache? segmentCache = null,
    TimeProvider? time = null,
    IReleaseHealthCache? healthCache = null,
    IRepairStreamGateway? repairGateway = null,
    IStreamHistoryRecorder? historyRecorder = null) : BackgroundService
{
    private const int DefaultArticleTelemetryCapacity = 500_000;
    private readonly ConcurrentDictionary<string, ActiveSession> _sessions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, RetainedArticleMap> _articleMaps = new(StringComparer.Ordinal);
    private readonly object _createGate = new();
    private readonly SemaphoreSlim _streamGate = new(Math.Max(1, options.Value.MaxConcurrentStreams));
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly int _articleTelemetryCapacity = DefaultArticleTelemetryCapacity;

    internal SessionManager(
        INntpClient nntpClient,
        IOptions<StreamarrOptions> options,
        ILogger<SessionManager> logger,
        int articleTelemetryCapacity,
        StreamarrMetrics? metrics = null,
        SegmentCache? segmentCache = null,
        TimeProvider? time = null,
        IReleaseHealthCache? healthCache = null,
        IRepairStreamGateway? repairGateway = null,
        IStreamHistoryRecorder? historyRecorder = null)
        : this(
            nntpClient,
            options,
            logger,
            metrics,
            segmentCache,
            time,
            healthCache,
            repairGateway,
            historyRecorder)
    {
        _articleTelemetryCapacity = articleTelemetryCapacity is >= 0 and <= DefaultArticleTelemetryCapacity
            ? articleTelemetryCapacity
            : throw new ArgumentOutOfRangeException(nameof(articleTelemetryCapacity));
    }

    /// <summary>Total NNTP commands in flight across all live sessions (connections in use).</summary>
    public int NntpConnectionsInUse => _sessions.Values.Sum(s => s.NntpUsage.InFlight);

    public ActiveSession CreateSession(
        string releaseId,
        string workId,
        ResolvedMediaFile file,
        string? client,
        string? requestedById = null,
        string? requestedByName = null,
        string? title = null,
        TtffTimeline? timeline = null,
        string? streamAttemptId = null)
    {
        lock (_createGate)
        {
            return CreateSessionLocked(
                releaseId,
                workId,
                file,
                client,
                requestedById,
                requestedByName,
                title,
                timeline,
                status: "ready",
                opening: false,
                streamAttemptId);
        }
    }

    /// <summary>
    /// Reuses the live capability for the same release and originating requester, or atomically
    /// admits one opening session. Matching the stable requester id prevents capability sharing
    /// across users while allowing pause/resume and client source reopens to retain one file.
    /// </summary>
    public SessionAdmission GetOrCreateOpeningSession(
        string releaseId,
        string workId,
        ResolvedMediaFile file,
        string status,
        string? client,
        string? requestedById = null,
        string? requestedByName = null,
        string? title = null,
        TtffTimeline? timeline = null,
        string? streamAttemptId = null,
        EphemeralRetentionPriority retentionPriority = EphemeralRetentionPriority.Normal)
    {
        lock (_createGate)
        {
            if (healthCache?.IsDead(releaseId) == true
                && repairGateway?.AllowsPlaybackWhileDead(releaseId) != true)
            {
                InvalidateReleaseSessionsLocked(releaseId);
                throw new SessionUnavailableException("The release became unavailable before session admission.");
            }

            var now = _time.GetUtcNow();
            SweepExpiredLocked(now);
            if (FindReusableLocked(releaseId, workId, client, requestedById) is { } reusable)
            {
                if (retentionPriority == EphemeralRetentionPriority.Normal)
                    reusable.PromoteRetention();
                reusable.Touch();
                logger.LogInformation(
                    "Reusing capability session {Token} for release {ReleaseId} and requester {RequestedById}",
                    reusable.Token[..8],
                    releaseId,
                    requestedById ?? requestedByName ?? "unknown");

                // This resolve attempt didn't mint a session of its own — close its history row
                // out immediately rather than leaving it open forever; the reused session's own
                // row (from whichever attempt originally created it) keeps tracking normally.
                if (streamAttemptId is not null)
                {
                    historyRecorder?.Finalize(streamAttemptId, new StreamRecordFinalize
                    {
                        FinalState = "reused",
                        CloseReason = $"reused session {reusable.Token[..8]} for release {releaseId}",
                        ResolvedReleaseId = reusable.Session.ReleaseId,
                        ResolvedTitle = reusable.Title,
                    });
                }

                return new SessionAdmission(reusable, Created: false);
            }

            return new SessionAdmission(
                CreateSessionLocked(
                    releaseId,
                    workId,
                    file,
                    client,
                    requestedById,
                    requestedByName,
                    title,
                    timeline,
                    status,
                    opening: true,
                    streamAttemptId,
                    retentionPriority),
                Created: true);
        }
    }

    public ActiveSession? FindReusableSession(
        string releaseId,
        string workId,
        string? client,
        string? requestedById = null,
        EphemeralRetentionPriority retentionPriority = EphemeralRetentionPriority.Normal)
    {
        lock (_createGate)
        {
            if (healthCache?.IsDead(releaseId) == true
                && repairGateway?.AllowsPlaybackWhileDead(releaseId) != true)
            {
                InvalidateReleaseSessionsLocked(releaseId);
                return null;
            }

            SweepExpiredLocked(_time.GetUtcNow());
            var reusable = FindReusableLocked(releaseId, workId, client, requestedById);
            if (retentionPriority == EphemeralRetentionPriority.Normal)
                reusable?.PromoteRetention();
            reusable?.Touch();
            return reusable;
        }
    }

    private ActiveSession? FindReusableLocked(
        string releaseId,
        string workId,
        string? client,
        string? requestedById)
    {
        // A client label or display name is not an authorization boundary. Only reuse a
        // capability when the caller supplies Jellyfin's stable requester id; otherwise two
        // anonymous users playing the same release could receive the same stream token.
        if (string.IsNullOrWhiteSpace(requestedById))
            return null;

        return _sessions.Values
            .Where(session =>
                !session.IsExpired(_time.GetUtcNow())
                && string.Equals(session.Session.ReleaseId, releaseId, StringComparison.Ordinal)
                && string.Equals(session.Session.WorkId, workId, StringComparison.Ordinal)
                && string.Equals(session.Session.Client, client, StringComparison.Ordinal)
                && string.Equals(session.Session.RequestedById, requestedById, StringComparison.Ordinal))
            .OrderByDescending(session => session.Session.State == SessionState.Ready)
            .ThenByDescending(session => session.Session.LastAccessedAt)
            .ThenByDescending(session => session.Session.CreatedAt)
            .FirstOrDefault();
    }

    private ActiveSession CreateSessionLocked(
        string releaseId,
        string workId,
        ResolvedMediaFile file,
        string? client,
        string? requestedById,
        string? requestedByName,
        string? title,
        TtffTimeline? timeline,
        string status,
        bool opening,
        string? streamAttemptId = null,
        EphemeralRetentionPriority retentionPriority = EphemeralRetentionPriority.Normal)
    {
        var now = _time.GetUtcNow();
        SweepExpiredLocked(now);
        MakeRoomFor(file.SizeBytes, retentionPriority);
        while (_sessions.Count >= options.Value.MaxSessions)
        {
            if (!EvictLeastRecentlyUsed(
                    "session-count limit",
                    backgroundOnly: retentionPriority == EphemeralRetentionPriority.Background))
            {
                throw new ResourceCapacityException(
                    retentionPriority == EphemeralRetentionPriority.Background
                        ? "The implicit pre-download cannot displace an explicitly requested session."
                        : "The live session limit has been reached.");
            }
        }

        // 192 bits of CSPRNG entropy — opaque and unguessable (BRIEF §6.4)
        var usage = new CountingNntpGate();
        IEnumerable<ArticleManifestEntry> articleManifest = file.ArticleManifest.Count > 0
            ? file.ArticleManifest
            : file.SegmentIds.Select((id, index) => new ArticleManifestEntry(id, file.FileName, index + 1));
        var requestedTrackerCapacity = Math.Min(
            ArticleDownloadTracker.MaxTrackedArticles,
            file.ArticleManifest.Count > 0 ? file.ArticleManifest.Count : file.SegmentIds.Count);
        PrepareArticleTelemetryCapacityLocked(now, requestedTrackerCapacity);
        var trackedArticles = TrackedArticleTelemetryCount();
        var trackerCapacity = Math.Clamp(
            _articleTelemetryCapacity - trackedArticles,
            0,
            ArticleDownloadTracker.MaxTrackedArticles);
        var articleTracker = new ArticleDownloadTracker(
            releaseId,
            articleManifest,
            _time,
            maxTrackedArticles: trackerCapacity);
        var sessionClient = new ArticleTrackingNntpClient(
            new GatedNntpClient(nntpClient, usage),
            articleTracker);

        ActiveSession active;
        do
        {
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var session = new StreamSession
            {
                Token = token,
                ReleaseId = releaseId,
                WorkId = workId,
                CreatedAt = now,
                LastAccessedAt = now,
                TimeToLive = TimeSpan.FromSeconds(options.Value.SessionTtlSeconds),
                Container = file.Container,
                SizeBytes = file.SizeBytes,
                Client = client,
                RequestedById = requestedById,
                RequestedByName = requestedByName,
                State = opening ? SessionState.Opening : SessionState.Ready,
            };
            active = new ActiveSession(
                session,
                file,
                sessionClient,
                usage,
                metrics,
                segmentCache,
                articleTracker,
                title,
                _time,
                status,
                opening,
                retentionPriority)
            {
                Timeline = timeline,
                StreamAttemptId = streamAttemptId,
            };
        } while (!_sessions.TryAdd(active.Token, active));

        if (streamAttemptId is not null)
            historyRecorder?.AttachToken(streamAttemptId, active.Token);

        metrics?.SessionOpened();
        logger.LogInformation(
            "Opened capability session for release {ReleaseId} ({FileName}, {SizeBytes} bytes, ttl {Ttl})",
            releaseId,
            file.FileName,
            file.SizeBytes,
            active.Session.TimeToLive);
        return active;
    }

    public bool TryGetSession(string token, out ActiveSession session)
    {
        if (_sessions.TryGetValue(token, out var found) && !found.IsExpired(_time.GetUtcNow()))
        {
            session = found;
            return true;
        }

        session = null!;
        return false;
    }

    public ActiveSession? FindForPlaybackEvent(
        string? token,
        string releaseId,
        string? workId,
        string? client,
        string? requestedById)
    {
        if (!string.IsNullOrWhiteSpace(token))
        {
            if (TryGetSession(token, out var exact)
                && string.Equals(exact.Session.ReleaseId, releaseId, StringComparison.Ordinal)
                && (string.IsNullOrWhiteSpace(workId)
                    || string.Equals(exact.Session.WorkId, workId, StringComparison.Ordinal)))
            {
                return exact;
            }
            return null;
        }

        return _sessions.Values
            .Where(session => !session.IsExpired(_time.GetUtcNow())
                              && string.Equals(session.Session.ReleaseId, releaseId, StringComparison.Ordinal)
                              && (string.IsNullOrWhiteSpace(workId)
                                  || string.Equals(session.Session.WorkId, workId, StringComparison.Ordinal))
                              && (string.IsNullOrWhiteSpace(client)
                                  || string.Equals(session.Session.Client, client, StringComparison.Ordinal))
                              && (string.IsNullOrWhiteSpace(requestedById)
                                  || string.Equals(
                                      session.Session.RequestedById,
                                      requestedById,
                                      StringComparison.Ordinal)))
            .OrderByDescending(session => session.IsStreaming)
            .ThenByDescending(session => session.Session.LastAccessedAt)
            .FirstOrDefault();
    }

    public Stream OpenPreDownloadSource(
        ActiveSession session,
        PreDownloadNntpClient lowPriorityClient)
    {
        if (!TryGetSession(session.Token, out var current) || !ReferenceEquals(current, session))
            throw new SessionUnavailableException("The pre-download target is no longer retained.");

        INntpClient client = new GatedNntpClient(
            lowPriorityClient,
            session.NntpUsage,
            disposeInner: false,
            disposeGate: false);
        if (session.ArticleTracker is { } tracker)
            client = new ArticleTrackingNntpClient(client, tracker);

        return session.File.OpenPreDownloadStream is { } preDownload
            ? preDownload(client, null, session.RecordTransferEvent)
            : session.File.OpenTelemetryStream is { } telemetry
            ? telemetry(client, null, session.RecordTransferEvent)
            : session.File.OpenObservedStream is { } observed
                ? observed(client, null)
                : session.File.OpenStream(client);
    }

    public ArticleDownloadTracker? GetArticleTracker(string token)
    {
        if (TryGetSession(token, out var live))
            return live.ArticleTracker;

        if (!_articleMaps.TryGetValue(token, out var retained))
            return null;
        if (retained.ExpiresAt > _time.GetUtcNow())
            return retained.Tracker;

        _articleMaps.TryRemove(token, out _);
        return null;
    }

    /// <summary>
    /// Opens a fresh stream over the session's media file for one HTTP request.
    /// </summary>
    /// <param name="session">The live session to stream.</param>
    /// <param name="paced">
    /// When false, skips the playback-pacing token bucket entirely (BRIEF full-speed download):
    /// reads proceed as fast as the underlying NNTP fetch can supply, unbounded by
    /// <see cref="StreamarrOptions.StreamPacingSustainBytesPerSecond"/>. Used by
    /// <c>GET /api/v1/download/{token}</c>; the playback path (<c>/api/v1/stream/{token}</c>)
    /// always passes true so on-demand playback keeps its existing TTFF/fairness behavior.
    /// </param>
    public Stream OpenStream(ActiveSession session, bool paced = true)
    {
        if (!_streamGate.Wait(0))
            throw new ResourceCapacityException("The concurrent stream limit has been reached.");

        var admitted = false;
        try
        {
            session.PromoteRetention();
            if (!session.TryOpenStream(
                    () => session.File.OpenTelemetryStream is { } telemetry
                        ? telemetry(session.NntpClient, session.RecordChunkRequested, session.RecordTransferEvent)
                        : session.File.OpenObservedStream is { } observed
                        ? observed(session.NntpClient, session.RecordChunkRequested)
                        : session.File.OpenStream(session.NntpClient),
                    out var inner)
                || inner is null)
            {
                throw new SessionUnavailableException("The capability session was closed or expired before streaming began.");
            }
            admitted = true;

            // Mid-stream damage escalates to the repair coordinator instead of EOF/invalidation;
            // healthy reads pass through this wrapper with zero repair I/O. Opening-phase
            // streams (resolve-time ffprobe) stay unwrapped so a damaged article keeps the
            // fast dead→fallback path instead of stalling the resolve at a hole.
            if (repairGateway is { Enabled: true } && session.Session.State == SessionState.Ready)
            {
                inner = new RepairAwareStream(
                    inner,
                    repairGateway,
                    new RepairStreamContext(
                        session.Session.ReleaseId,
                        session.Session.WorkId,
                        session.Title));
            }

            inner = new PreDownloadAwareStream(inner, () => session.PreDownloadCache);

            // Offset (from resolve t0) at which this HTTP stream request opened its stream, so the
            // first-byte span lands in the right place on the request→first-frame flamegraph.
            var openMs = session.Timeline?.ElapsedMs;

            var o = options.Value;
            var sustainBytesPerSecond = session.GetPacingSustainBytesPerSecond(
                o.StreamPacingSustainBytesPerSecond);
            var pacer = paced && o.StreamPacingEnabled
                ? new StreamPacer(
                    o.StreamPacingBurstBytes,
                    sustainBytesPerSecond,
                    onEngaged: () =>
                    {
                        logger.LogDebug(
                            "[TTFF] {Token} stream pacing engaged after {BurstBytes} bytes (sustain {SustainBytesPerSecond} B/s)",
                            session.Token[..8], o.StreamPacingBurstBytes, sustainBytesPerSecond);
                        session.Timeline?.Add(
                            "pacing-engaged", "stream", session.Timeline.ElapsedMs, 0,
                            detail: $"sustain={sustainBytesPerSecond:F0}B/s");
                    })
                : null;

            return new SessionStream(
                inner,
                session,
                openMs,
                () =>
                {
                    try
                    {
                        session.EndStream();
                    }
                    finally
                    {
                        _streamGate.Release();
                    }
                },
                pacer,
                exception => RecordStreamReadFailure(session, exception));
        }
        catch
        {
            if (admitted)
                session.EndStream();
            _streamGate.Release();
            throw;
        }
    }

    private void RecordStreamReadFailure(ActiveSession session, Exception exception)
    {
        var properties = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            [LogPropertyNames.ReleaseId] = session.Session.ReleaseId,
            [LogPropertyNames.WorkId] = session.Session.WorkId,
            [LogPropertyNames.StreamTokenFingerprint] = LogSanitizer.FingerprintToken(session.Token),
        };
        if (!string.IsNullOrWhiteSpace(session.StreamAttemptId))
            properties[LogPropertyNames.StreamAttemptId] = session.StreamAttemptId!;

        using var scope = logger.BeginScope(properties);
        if (exception is OperationCanceledException)
        {
            logger.LogDebug(
                "Stream read for release {ReleaseId} was cancelled by the client",
                session.Session.ReleaseId);
            return;
        }

        logger.LogError(
            exception,
            "Stream read failed for release {ReleaseId} ({FailureType})",
            session.Session.ReleaseId,
            exception.GetType().Name);

        if (historyRecorder is not null && session.StreamAttemptId is { } attemptId)
        {
            historyRecorder.AppendEvents(attemptId,
            [
                new StreamEventWrite(
                    DateTimeOffset.UtcNow,
                    "error",
                    "stream",
                    exception.GetType().Name,
                    LogSanitizer.SanitizeAndTruncate(exception.Message, 1_024)),
            ]);
        }

        InvalidateMissingRelease(session, exception);
    }

    private void InvalidateMissingRelease(ActiveSession session, Exception exception)
    {
        if (!RepairAwareStream.IsRepairableFailure(exception))
            return;

        // While a repair job or a local artifact can still serve this release, sessions
        // must survive; only origin evidence is recorded (by the repair gateway).
        if (repairGateway?.AllowsPlaybackWhileDead(session.Session.ReleaseId) == true)
        {
            healthCache?.Record(session.Session.ReleaseId, ReleaseHealth.Dead);
            logger.LogWarning(
                "Release {ReleaseId} lost an article mid-stream; repair is active, keeping capability sessions alive",
                session.Session.ReleaseId);
            return;
        }

        int removed;
        lock (_createGate)
        {
            healthCache?.Record(session.Session.ReleaseId, ReleaseHealth.Dead);
            removed = InvalidateReleaseSessionsLocked(session.Session.ReleaseId);
        }

        logger.LogWarning(
            "Release {ReleaseId} became unavailable while streaming; marked dead and invalidated {RemovedCapabilities} capability session(s)",
            session.Session.ReleaseId,
            removed);
    }

    /// <summary>
    /// Flushes this session's full diagnostic timeline and closes out its permanent history
    /// row (BRIEF §11 console), when history tracking is enabled and this session was opened
    /// under a tracked resolve attempt. Best-effort: every call into the history recorder
    /// is a non-blocking queue write, so this can never throw or stall a removal path.
    /// </summary>
    private void RecordHistoryClose(ActiveSession session, string finalState, string? reason)
    {
        RetainArticleMap(session);
        if (historyRecorder is null || session.StreamAttemptId is not { } attemptId)
            return;

        historyRecorder.AppendEvents(attemptId, StreamHistoryRecorder.EventsFromTimeline(session.Timeline));
        historyRecorder.Finalize(attemptId, new StreamRecordFinalize
        {
            FinalState = finalState,
            CloseReason = reason,
            ResolvedReleaseId = session.Session.ReleaseId,
            ResolvedTitle = session.Title,
            Container = session.File.Container,
            SizeBytes = session.File.SizeBytes,
            BytesServed = session.BytesServed,
            NntpCommandsTotal = session.NntpUsage.TotalCommands,
        });
    }

    private void RetainArticleMap(ActiveSession session)
    {
        if (session.ArticleTracker is not { } tracker)
            return;

        lock (_createGate)
        {
            var now = _time.GetUtcNow();
            PruneExpiredArticleMapsLocked(now);
            _articleMaps[session.Token] = new RetainedArticleMap(
                tracker,
                now.AddHours(1));
            while (_articleMaps.Count > 5
                   || TrackedArticleTelemetryCount() > _articleTelemetryCapacity)
            {
                if (!RemoveOldestRetainedArticleMapLocked())
                    break;
            }
        }
    }

    private void PrepareArticleTelemetryCapacityLocked(
        DateTimeOffset now,
        int requestedTrackerCapacity)
    {
        PruneExpiredArticleMapsLocked(now);
        var retainedBudget = Math.Max(0, _articleTelemetryCapacity - requestedTrackerCapacity);
        while (!_articleMaps.IsEmpty && TrackedArticleTelemetryCount() > retainedBudget)
        {
            if (!RemoveOldestRetainedArticleMapLocked())
                break;
        }
    }

    private void PruneExpiredArticleMapsLocked(DateTimeOffset now)
    {
        foreach (var (token, retained) in _articleMaps)
        {
            if (retained.ExpiresAt <= now)
                _articleMaps.TryRemove(token, out _);
        }
    }

    private bool RemoveOldestRetainedArticleMapLocked()
    {
        var oldest = _articleMaps.MinBy(pair => pair.Value.ExpiresAt);
        return !string.IsNullOrEmpty(oldest.Key)
               && _articleMaps.TryRemove(oldest.Key, out _);
    }

    private int TrackedArticleTelemetryCount()
        => _sessions.Values.Sum(session => session.ArticleTracker?.TrackedArticleCount ?? 0)
            + _articleMaps.Values.Sum(retained => retained.Tracker.TrackedArticleCount);

    private int InvalidateReleaseSessionsLocked(string releaseId)
    {
        var removed = 0;
        foreach (var (token, candidate) in _sessions)
        {
            if (!string.Equals(candidate.Session.ReleaseId, releaseId, StringComparison.Ordinal)
                || !_sessions.TryRemove(token, out var invalidated))
            {
                continue;
            }

            invalidated.MarkClosed();
            metrics?.SessionClosed();
            RecordHistoryClose(invalidated, "invalidated", "release became unavailable");
            removed++;
        }

        return removed;
    }

    private sealed record RetainedArticleMap(
        ArticleDownloadTracker Tracker,
        DateTimeOffset ExpiresAt);

    public bool CloseSession(string token)
    {
        if (!_sessions.TryRemove(token, out var session))
            return false;

        session.MarkClosed();
        metrics?.SessionClosed();
        RecordHistoryClose(session, "closed", reason: null);
        logger.LogInformation(
            "Closed capability session for release {ReleaseId} ({BytesServed} bytes served)",
            session.Session.ReleaseId, session.BytesServed);
        return true;
    }

    internal IReadOnlyList<SupersededSession> SupersedeOtherReleases(
        ActiveSession selected,
        int graceSeconds)
    {
        ArgumentNullException.ThrowIfNull(selected);
        var requesterId = selected.Session.RequestedById;
        var client = selected.Session.Client;
        if (string.IsNullOrWhiteSpace(requesterId)
            || string.IsNullOrWhiteSpace(client)
            || !CanonicalTmdbWorkId.TryNormalize(selected.Session.WorkId, out var workId))
        {
            return [];
        }

        List<SupersededSession> removed = [];
        lock (_createGate)
        {
            if (!_sessions.TryGetValue(selected.Token, out var current)
                || !ReferenceEquals(current, selected))
            {
                return [];
            }

            foreach (var candidate in _sessions.Values
                         .Where(candidate => candidate.Token != selected.Token
                                             && candidate.Session.ReleaseId != selected.Session.ReleaseId
                                             && CanonicalTmdbWorkId.TryNormalize(
                                                 candidate.Session.WorkId,
                                                 out var candidateWorkId)
                                             && candidateWorkId == workId
                                             && candidate.Session.Client == client
                                             && candidate.Session.RequestedById == requesterId)
                         .OrderBy(candidate => candidate.Session.CreatedAt)
                         .ThenBy(candidate => candidate.Token, StringComparer.Ordinal)
                         .ToArray())
            {
                if (!_sessions.TryRemove(
                        new KeyValuePair<string, ActiveSession>(candidate.Token, candidate)))
                {
                    continue;
                }

                var preDownloadedBytes = candidate.PreDownloadCache?.DownloadedBytes ?? 0;
                var preDownloadState = candidate.PreDownloadCache switch
                {
                    null => "none",
                    { IsComplete: true } => "completed",
                    { IsCancelled: true } => "cancelled",
                    _ => "downloading",
                };
                var reason = $"release {candidate.Session.ReleaseId} was superseded by {selected.Session.ReleaseId} after the {graceSeconds}-second playback grace period";

                if (historyRecorder is not null && candidate.StreamAttemptId is { } attemptId)
                {
                    historyRecorder.AppendEvents(attemptId,
                    [
                        new StreamEventWrite(
                            _time.GetUtcNow(),
                            "lifecycle",
                            "release",
                            "release-superseded",
                            reason),
                    ]);
                }

                candidate.MarkClosed();
                metrics?.SessionClosed();
                RecordHistoryClose(candidate, "purged", reason);
                removed.Add(new SupersededSession(
                    candidate.Token,
                    candidate.Session.ReleaseId,
                    candidate.PreDownloadJobId,
                    preDownloadedBytes));

                using var scope = logger.BeginScope(new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    [LogPropertyNames.ReleaseId] = candidate.Session.ReleaseId,
                    [LogPropertyNames.WorkId] = workId,
                    [LogPropertyNames.StreamTokenFingerprint] = LogSanitizer.FingerprintToken(candidate.Token),
                });
                logger.LogInformation(
                    "Purged superseded release {OldReleaseId} after requester {RequestedById} on {Client} selected {NewReleaseId} for work {WorkId} and passed the {GraceSeconds}-second playback grace; pre-download state was {PreDownloadState} ({PreDownloadedBytes} bytes)",
                    candidate.Session.ReleaseId,
                    requesterId,
                    client,
                    selected.Session.ReleaseId,
                    workId,
                    graceSeconds,
                    preDownloadState,
                    preDownloadedBytes);
            }
        }

        return removed;
    }

    /// <summary>
    /// Manually purges one ephemeral file, refusing to evict a file that is being actively
    /// streamed so an operator cannot tear playback out from under a client. Unlike
    /// <see cref="CloseSession"/> (which force-closes regardless of streaming), this is the
    /// operator-facing "reclaim idle cache now" control.
    /// </summary>
    public PurgeOutcome PurgeSession(string token)
        => PurgeSession(token, requiredPriority: null);

    internal PurgeOutcome PurgeBackgroundSession(string token)
        => PurgeSession(token, EphemeralRetentionPriority.Background);

    private PurgeOutcome PurgeSession(
        string token,
        EphemeralRetentionPriority? requiredPriority)
    {
        if (!TryGetSession(token, out var session))
            return PurgeOutcome.NotFound;

        if (!session.TryPurgeIfIdle(requiredPriority))
            return PurgeOutcome.Streaming;

        _sessions.TryRemove(token, out _);
        metrics?.SessionClosed();
        RecordHistoryClose(session, "purged", "reclaimed idle cache on operator request");
        logger.LogInformation(
            "Purged ephemeral file for release {ReleaseId} ({BytesServed} bytes served) on operator request",
            session.Session.ReleaseId, session.BytesServed);
        return PurgeOutcome.Purged;
    }

    public IReadOnlyList<ActiveSession> ListSessions()
        => _sessions.Values.OrderBy(s => s.Session.CreatedAt).ToList();

    public IReadOnlyList<LocalReleaseAvailability> ListLocalReleaseAvailability(
        IReadOnlySet<string> workIds,
        string client,
        string requestedById)
    {
        ArgumentNullException.ThrowIfNull(workIds);
        ArgumentException.ThrowIfNullOrWhiteSpace(client);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestedById);
        var now = _time.GetUtcNow();
        return _sessions.Values
            .Where(session => workIds.Contains(session.Session.WorkId)
                              && !session.IsExpired(now)
                              && string.Equals(session.Session.Client, client, StringComparison.Ordinal)
                              && string.Equals(session.Session.RequestedById, requestedById, StringComparison.Ordinal)
                              && session.PreDownloadCache is { IsCancelled: false })
            .Select(session => new LocalReleaseAvailability(
                session.Session.WorkId,
                session.Session.ReleaseId,
                session.PreDownloadCache!.IsComplete ? "ready" : "downloading"))
            .GroupBy(release => (release.WorkId, release.ReleaseId))
            .Select(group => new LocalReleaseAvailability(
                group.Key.WorkId,
                group.Key.ReleaseId,
                group.Any(release => release.State == "ready") ? "ready" : "downloading"))
            .OrderBy(release => release.WorkId, StringComparer.Ordinal)
            .ThenByDescending(release => release.State == "ready")
            .ThenBy(release => release.ReleaseId, StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>Removes sessions whose hard creation-based TTL has lapsed.</summary>
    public int SweepExpired()
    {
        lock (_createGate)
            return SweepExpiredLocked(_time.GetUtcNow());
    }

    private int SweepExpiredLocked(DateTimeOffset now)
    {
        var removed = 0;
        PruneExpiredArticleMapsLocked(now);

        foreach (var (token, session) in _sessions)
        {
            if (!session.IsExpired(now))
                continue;
            if (!_sessions.TryRemove(token, out var expired))
                continue;

            expired.MarkClosed();
            metrics?.SessionClosed();
            RecordHistoryClose(expired, "expired", "hard TTL reached");
            removed++;
            logger.LogInformation(
                "Expired ephemeral file for release {ReleaseId} (hard ttl reached)",
                expired.Session.ReleaseId);
        }

        return removed;
    }

    private void MakeRoomFor(
        long incomingSizeBytes,
        EphemeralRetentionPriority incomingPriority)
    {
        var capacityBytes = checked((long)options.Value.EphemeralCacheSizeMb * 1024 * 1024);
        if (incomingPriority == EphemeralRetentionPriority.Background
            && incomingSizeBytes > capacityBytes)
        {
            throw new ResourceCapacityException(
                "The implicit pre-download is larger than the ephemeral cache budget.");
        }
        while (!_sessions.IsEmpty
               && CacheSizeBytes() > capacityBytes - Math.Min(incomingSizeBytes, capacityBytes))
        {
            if (!EvictLeastRecentlyUsed(
                    "ephemeral-cache byte budget",
                    backgroundOnly: incomingPriority == EphemeralRetentionPriority.Background))
            {
                throw new ResourceCapacityException(
                    "The implicit pre-download cannot displace an explicitly requested file.");
            }
        }
    }

    private long CacheSizeBytes()
    {
        long total = 0;
        foreach (var session in _sessions.Values)
            total = checked(total + session.Session.SizeBytes);
        return total;
    }

    private bool EvictLeastRecentlyUsed(string reason, bool backgroundOnly = false)
    {
        foreach (var candidate in _sessions.Values
                     .Where(session => !backgroundOnly
                                       || session.RetentionPriority == EphemeralRetentionPriority.Background)
                     .OrderBy(session => session.RetentionPriority)
                     .ThenBy(session => session.Session.LastAccessedAt)
                     .ThenBy(session => session.Session.CreatedAt)
                     .ThenBy(session => session.Token, StringComparer.Ordinal))
        {
            if (!_sessions.TryRemove(candidate.Token, out var evicted))
                continue;

            evicted.MarkClosed();
            metrics?.SessionClosed();
            RecordHistoryClose(evicted, "evicted", reason);
            logger.LogInformation(
                "Evicted ephemeral file for release {ReleaseId} ({SizeBytes} bytes, last access {LastAccessedAt}) because of {Reason}",
                evicted.Session.ReleaseId,
                evicted.Session.SizeBytes,
                evicted.Session.LastAccessedAt,
                reason);
            return true;
        }

        return false;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, options.Value.SessionSweepIntervalSeconds));
        try
        {
            using var timer = new PeriodicTimer(interval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
                SweepExpired();
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
    }
}

/// <summary>
/// Read-only forwarding stream handed to the HTTP layer: meters bytes served,
/// refreshes the session's LRU timestamp on activity, and refuses further reads
/// once the entry is evicted or reaches its hard expiry.
/// </summary>
internal sealed class SessionStream(
    Stream inner,
    ActiveSession session,
    double? openMs = null,
    Action? onDispose = null,
    StreamPacer? pacer = null,
    Action<Exception>? onReadFailure = null) : Stream
{
    private int _disposed;
    public override bool CanRead => true;
    public override bool CanSeek => inner.CanSeek;
    public override bool CanWrite => false;
    public override long Length => inner.Length;

    public override long Position
    {
        get => inner.Position;
        set => inner.Position = value;
    }

    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(session.IsClosed, this);
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            session.LifetimeToken);
        var readCancellationToken = linkedCancellation.Token;
        int read;
        try
        {
            read = await inner.ReadAsync(buffer, readCancellationToken);
        }
        catch (Exception e)
        {
            onReadFailure?.Invoke(e);
            throw;
        }
        if (read > 0)
        {
            if (openMs is { } start
                && session.Timeline is { } timeline
                && session.TryRecordInitialMediaByte())
            {
                // Gap between this stream HTTP request opening and its first delivered byte
                // (NNTP article fetch + yEnc decode, or a seek's interpolation search).
                timeline.Add("stream-first-byte", "stream", start, timeline.ElapsedMs - start,
                    detail: $"pos={inner.Position - read}");
            }

            session.AddBytesServed(read);
            session.Touch();

            if (pacer is not null)
                await pacer.PaceAsync(read, readCancellationToken);
        }

        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int count)
        => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override void Flush()
    {
    }

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing && Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            try
            {
                inner.Dispose();
            }
            finally
            {
                onDispose?.Invoke();
            }
        }
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            try
            {
                await inner.DisposeAsync();
            }
            finally
            {
                onDispose?.Invoke();
            }
        }
        await base.DisposeAsync();
    }
}

/// <summary>
/// Per-request output pacing: a generous unpaced startup burst (fast first frame, fast
/// seeks — every new Range request gets a fresh burst — and an unaffected ffprobe), then a
/// media-aware sustained byte rate at least twice the file's average bitrate. This is the
/// server-side stand-in for Jellyfin's transcode throttler, which never engages for HTTP
/// inputs (TranscodeManager.EnableThrottling requires MediaProtocol.File): without pacing,
/// one ffmpeg stream-copy races the entire release at wire speed, and abandoned transcodes
/// keep racing, starving concurrent playback into minutes of TTFF (measured 52–134 s).
/// </summary>
internal sealed class StreamPacer(long burstBytes, double sustainBytesPerSecond, Action? onEngaged = null)
{
    // HLS remuxing needs to produce segments ahead of the playhead, not merely match the
    // file's average bitrate. Two times average leaves room for variable-bitrate peaks while
    // still preventing ffmpeg from racing an entire release at provider wire speed.
    internal const double RealtimeHeadroomMultiplier = 2;

    private long _total;
    private long _paceStartTimestamp;

    /// <summary>
    /// Selects a correctness-safe pacing rate. The configured value is a floor, while known
    /// media must be allowed to arrive faster than real time. A fixed global ceiling made
    /// high-bitrate Swiftfin HLS playback drain the startup burst and then permanently starve
    /// Jellyfin's next segment even though Core kept downloading in the background.
    /// </summary>
    internal static double SelectSustainBytesPerSecond(
        long sizeBytes,
        long runTimeTicks,
        double configuredFloor)
    {
        if (sizeBytes <= 0 || runTimeTicks <= 0)
            return configuredFloor;

        var durationSeconds = runTimeTicks / (double)TimeSpan.TicksPerSecond;
        var mediaRate = sizeBytes / durationSeconds;
        if (!double.IsFinite(mediaRate) || mediaRate <= 0)
            return configuredFloor;

        return Math.Max(configuredFloor, mediaRate * RealtimeHeadroomMultiplier);
    }

    /// <summary>Delays after a read once the burst is spent, holding the stream to the sustain rate.</summary>
    public async ValueTask PaceAsync(int justRead, CancellationToken ct)
    {
        // One pacer per HTTP request stream; reads are sequential, so plain fields suffice.
        _total += justRead;
        var beyondBurst = _total - burstBytes;
        if (beyondBurst <= 0)
            return;

        if (_paceStartTimestamp == 0)
        {
            _paceStartTimestamp = Stopwatch.GetTimestamp();
            onEngaged?.Invoke();
            return;
        }

        var expectedSeconds = beyondBurst / sustainBytesPerSecond;
        var aheadSeconds = expectedSeconds - Stopwatch.GetElapsedTime(_paceStartTimestamp).TotalSeconds;
        if (aheadSeconds > 0.002)
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(aheadSeconds, 0.5)), ct);
    }
}

/// <summary>A configured, retryable process/session/stream capacity was reached.</summary>
public sealed class ResourceCapacityException(string message) : Exception(message);

/// <summary>A previously resolved capability was closed or expired during stream admission.</summary>
public sealed class SessionUnavailableException(string message) : Exception(message);

/// <summary>Content-Type by container so players negotiate correctly (BRIEF §6.2).</summary>
public static class ContainerContentTypes
{
    public static string For(string container) => container.ToLowerInvariant() switch
    {
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp4" or "m4v" => "video/mp4",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "wmv" => "video/x-ms-wmv",
        "ts" or "m2ts" => "video/mp2t",
        "mpg" or "mpeg" or "vob" => "video/mpeg",
        "flv" => "video/x-flv",
        "ogm" => "video/ogg",
        _ => "application/octet-stream",
    };
}
