using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Streamarr.Core.Sessions;
using Streamarr.Server.Options;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Services;

/// <summary>
/// One live streaming session (BRIEF §6.1 module 6): the resolved media file,
/// a per-session NNTP client metering usage against the shared global budget,
/// and deterministic ephemeral-cache bookkeeping.
/// </summary>
public sealed class ActiveSession
{
    private long _bytesServed;
    private int _openStreamCount;
    private int _closed;
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
        string? title = null,
        TimeProvider? time = null)
    {
        Session = session;
        File = file;
        NntpClient = nntpClient;
        NntpUsage = nntpUsage;
        ContentType = ContainerContentTypes.For(file.Container);
        _metrics = metrics;
        _segmentCache = segmentCache;
        _time = time ?? TimeProvider.System;
        Title = string.IsNullOrWhiteSpace(title) ? file.FileName : title;
    }

    public StreamSession Session { get; }
    public ResolvedMediaFile File { get; }
    public INntpClient NntpClient { get; }
    public CountingNntpGate NntpUsage { get; }
    public string ContentType { get; }
    public string Title { get; }

    /// <summary>
    /// Request→first-frame timing for this playback attempt (BRIEF §11 diagnostics). Populated
    /// during resolve, extended by the stream first-byte and by client-reported spans, and
    /// rendered as a flamegraph on the stream page. Null when diagnostics are unavailable.
    /// </summary>
    public TtffTimeline? Timeline { get; internal set; }

    public string Token => Session.Token;
    public long BytesServed => Interlocked.Read(ref _bytesServed);
    // SessionStream checks this for every body read. Keep the playback hot path lock-free; the
    // lifecycle gate is still used where open/close admission must be serialized.
    public bool IsClosed => Volatile.Read(ref _closed) != 0;

    public DateTimeOffset ExpiresAt
    {
        get
        {
            lock (_lifecycleGate)
                return Session.ExpiresAt;
        }
    }
    public int ChunksQueried => _queriedChunks.Count;
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

    internal void AddBytesServed(long count)
    {
        Session.BytesServed = Interlocked.Add(ref _bytesServed, count);
        _metrics?.AddBytesServed(count);
    }

    internal void MarkClosed()
    {
        lock (_lifecycleGate)
        {
            Volatile.Write(ref _closed, 1);
            Session.State = SessionState.Closed;
        }
    }
}

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
    TimeProvider? time = null) : BackgroundService
{
    private readonly ConcurrentDictionary<string, ActiveSession> _sessions = new(StringComparer.Ordinal);
    private readonly object _createGate = new();
    private readonly SemaphoreSlim _streamGate = new(Math.Max(1, options.Value.MaxConcurrentStreams));
    private readonly TimeProvider _time = time ?? TimeProvider.System;

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
        TtffTimeline? timeline = null)
    {
        lock (_createGate)
        {
            var now = _time.GetUtcNow();
            SweepExpiredLocked(now);
            MakeRoomFor(file.SizeBytes);
            while (_sessions.Count >= options.Value.MaxSessions)
            {
                if (!EvictLeastRecentlyUsed("session-count limit"))
                    throw new ResourceCapacityException("The live session limit has been reached.");
            }

            // 192 bits of CSPRNG entropy — opaque and unguessable (BRIEF §6.4)
            var usage = new CountingNntpGate();
            var sessionClient = new GatedNntpClient(nntpClient, usage);

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
                    State = SessionState.Ready,
                };
                active = new ActiveSession(session, file, sessionClient, usage, metrics, segmentCache, title, _time)
                {
                    Timeline = timeline,
                };
            } while (!_sessions.TryAdd(active.Token, active));

            metrics?.SessionOpened();
            logger.LogInformation(
                "Opened capability session for release {ReleaseId} ({FileName}, {SizeBytes} bytes, ttl {Ttl})",
                releaseId, file.FileName, file.SizeBytes, active.Session.TimeToLive);
            return active;
        }
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

    /// <summary>Opens a fresh stream over the session's media file for one HTTP request.</summary>
    public Stream OpenStream(ActiveSession session)
    {
        if (!_streamGate.Wait(0))
            throw new ResourceCapacityException("The concurrent stream limit has been reached.");

        var admitted = false;
        try
        {
            if (!session.TryOpenStream(
                    () => session.File.OpenObservedStream is { } observed
                        ? observed(session.NntpClient, session.RecordChunkRequested)
                        : session.File.OpenStream(session.NntpClient),
                    out var inner)
                || inner is null)
            {
                throw new SessionUnavailableException("The capability session was closed or expired before streaming began.");
            }
            admitted = true;

            // Offset (from resolve t0) at which this HTTP stream request opened its stream, so the
            // first-byte span lands in the right place on the request→first-frame flamegraph.
            var openMs = session.Timeline?.ElapsedMs;

            var o = options.Value;
            var pacer = o.StreamPacingEnabled
                ? new StreamPacer(
                    o.StreamPacingBurstBytes,
                    o.StreamPacingSustainBytesPerSecond,
                    onEngaged: () =>
                    {
                        logger.LogDebug(
                            "[TTFF] {Token} stream pacing engaged after {BurstBytes} bytes (sustain {SustainBytesPerSecond} B/s)",
                            session.Token[..8], o.StreamPacingBurstBytes, o.StreamPacingSustainBytesPerSecond);
                        session.Timeline?.Add(
                            "pacing-engaged", "stream", session.Timeline.ElapsedMs, 0,
                            detail: $"sustain={o.StreamPacingSustainBytesPerSecond}B/s");
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
                pacer);
        }
        catch
        {
            if (admitted)
                session.EndStream();
            _streamGate.Release();
            throw;
        }
    }

    public bool CloseSession(string token)
    {
        if (!_sessions.TryRemove(token, out var session))
            return false;

        session.MarkClosed();
        metrics?.SessionClosed();
        logger.LogInformation(
            "Closed capability session for release {ReleaseId} ({BytesServed} bytes served)",
            session.Session.ReleaseId, session.BytesServed);
        return true;
    }

    public IReadOnlyList<ActiveSession> ListSessions()
        => _sessions.Values.OrderBy(s => s.Session.CreatedAt).ToList();

    /// <summary>Removes sessions whose hard creation-based TTL has lapsed.</summary>
    public int SweepExpired()
    {
        lock (_createGate)
            return SweepExpiredLocked(_time.GetUtcNow());
    }

    private int SweepExpiredLocked(DateTimeOffset now)
    {
        var removed = 0;
        foreach (var (token, session) in _sessions)
        {
            if (!session.IsExpired(now))
                continue;
            if (!_sessions.TryRemove(token, out var expired))
                continue;

            expired.MarkClosed();
            metrics?.SessionClosed();
            removed++;
            logger.LogInformation(
                "Expired ephemeral file for release {ReleaseId} (hard ttl reached)",
                expired.Session.ReleaseId);
        }

        return removed;
    }

    private void MakeRoomFor(long incomingSizeBytes)
    {
        var capacityBytes = checked((long)options.Value.EphemeralCacheSizeMb * 1024 * 1024);
        while (!_sessions.IsEmpty
               && CacheSizeBytes() > capacityBytes - Math.Min(incomingSizeBytes, capacityBytes))
        {
            if (!EvictLeastRecentlyUsed("ephemeral-cache byte budget"))
                break;
        }
    }

    private long CacheSizeBytes()
    {
        long total = 0;
        foreach (var session in _sessions.Values)
            total = checked(total + session.Session.SizeBytes);
        return total;
    }

    private bool EvictLeastRecentlyUsed(string reason)
    {
        foreach (var candidate in _sessions.Values
                     .OrderBy(session => session.Session.LastAccessedAt)
                     .ThenBy(session => session.Session.CreatedAt)
                     .ThenBy(session => session.Token, StringComparer.Ordinal))
        {
            if (!_sessions.TryRemove(candidate.Token, out var evicted))
                continue;

            evicted.MarkClosed();
            metrics?.SessionClosed();
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
    StreamPacer? pacer = null) : Stream
{
    private int _disposed;
    private int _firstByteRecorded;
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
        var read = await inner.ReadAsync(buffer, cancellationToken);
        if (read > 0)
        {
            if (openMs is { } start
                && session.Timeline is { } timeline
                && Interlocked.Exchange(ref _firstByteRecorded, 1) == 0)
            {
                // Gap between this stream HTTP request opening and its first delivered byte
                // (NNTP article fetch + yEnc decode, or a seek's interpolation search).
                timeline.Add("stream-first-byte", "stream", start, timeline.ElapsedMs - start,
                    detail: $"pos={inner.Position - read}");
            }

            session.AddBytesServed(read);
            session.Touch();

            if (pacer is not null)
                await pacer.PaceAsync(read, cancellationToken);
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
/// sustained byte-rate ceiling still far above realtime playback. This is the server-side
/// stand-in for Jellyfin's transcode throttler, which never engages for HTTP inputs
/// (TranscodeManager.EnableThrottling requires MediaProtocol.File): without pacing, one
/// ffmpeg stream-copy races the entire release at wire speed, and abandoned transcodes keep
/// racing, starving concurrent playback into minutes of TTFF (measured 52–134 s).
/// </summary>
internal sealed class StreamPacer(long burstBytes, double sustainBytesPerSecond, Action? onEngaged = null)
{
    private long _total;
    private long _paceStartTimestamp;

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
