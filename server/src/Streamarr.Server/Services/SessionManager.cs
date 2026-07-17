using System.Collections.Concurrent;
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
/// and the sliding-TTL bookkeeping.
/// </summary>
public sealed class ActiveSession
{
    private long _bytesServed;
    private readonly StreamarrMetrics? _metrics;
    private readonly SegmentCache? _segmentCache;
    private readonly ConcurrentDictionary<string, byte> _queriedChunks = new(StringComparer.Ordinal);

    internal ActiveSession(
        StreamSession session,
        ResolvedMediaFile file,
        INntpClient nntpClient,
        CountingNntpGate nntpUsage,
        StreamarrMetrics? metrics = null,
        SegmentCache? segmentCache = null,
        string? title = null)
    {
        Session = session;
        File = file;
        NntpClient = nntpClient;
        NntpUsage = nntpUsage;
        ContentType = ContainerContentTypes.For(file.Container);
        _metrics = metrics;
        _segmentCache = segmentCache;
        Title = string.IsNullOrWhiteSpace(title) ? file.FileName : title;
    }

    public StreamSession Session { get; }
    public ResolvedMediaFile File { get; }
    public INntpClient NntpClient { get; }
    public CountingNntpGate NntpUsage { get; }
    public string ContentType { get; }
    public string Title { get; }

    public string Token => Session.Token;
    public long BytesServed => Interlocked.Read(ref _bytesServed);
    public bool IsClosed => Session.State == SessionState.Closed;
    public DateTimeOffset ExpiresAt => Session.ExpiresAt;
    public int ChunksQueried => _queriedChunks.Count;
    public double EstimatedStreamedPercent => File.SegmentIds.Count == 0
        ? 0
        : Math.Min(100, ChunksQueried * 100d / File.SegmentIds.Count);
    public (int Count, long Bytes) CachedStorage => _segmentCache?.GetStats(File.SegmentIds) ?? (0, 0);

    public void Touch() => Session.LastAccessedAt = DateTimeOffset.UtcNow;

    internal void RecordChunkRequested(string segmentId) => _queriedChunks.TryAdd(segmentId, 0);

    internal void AddBytesServed(long count)
    {
        Session.BytesServed = Interlocked.Add(ref _bytesServed, count);
        _metrics?.AddBytesServed(count);
    }

    internal void MarkClosed() => Session.State = SessionState.Closed;
}

/// <summary>
/// Owns the resolve → stream → close lifecycle: issues opaque unguessable stream
/// tokens, opens per-request streams over a session's media file, tears sessions
/// down on close, and expires them past their sliding TTL via a background sweep.
/// All sessions share one budgeted NNTP client, so the global connection budget
/// holds across concurrent sessions.
/// </summary>
public sealed class SessionManager(
    INntpClient nntpClient,
    IOptions<StreamarrOptions> options,
    ILogger<SessionManager> logger,
    StreamarrMetrics? metrics = null,
    SegmentCache? segmentCache = null) : BackgroundService
{
    private readonly ConcurrentDictionary<string, ActiveSession> _sessions = new(StringComparer.Ordinal);
    private readonly object _createGate = new();
    private readonly SemaphoreSlim _streamGate = new(Math.Max(1, options.Value.MaxConcurrentStreams));

    /// <summary>Total NNTP commands in flight across all live sessions (connections in use).</summary>
    public int NntpConnectionsInUse => _sessions.Values.Sum(s => s.NntpUsage.InFlight);

    public ActiveSession CreateSession(
        string releaseId,
        string workId,
        ResolvedMediaFile file,
        string? client,
        string? requestedById = null,
        string? requestedByName = null,
        string? title = null)
    {
        lock (_createGate)
        {
            SweepExpired();
            if (_sessions.Count >= options.Value.MaxSessions)
                throw new ResourceCapacityException("The live session limit has been reached.");

            // 192 bits of CSPRNG entropy — opaque and unguessable (BRIEF §6.4)
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            var now = DateTimeOffset.UtcNow;

            var usage = new CountingNntpGate();
            var sessionClient = new GatedNntpClient(nntpClient, usage);

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

            var active = new ActiveSession(session, file, sessionClient, usage, metrics, segmentCache, title);
            _sessions[token] = active;
            metrics?.SessionOpened();
            logger.LogInformation(
                "Opened capability session for release {ReleaseId} ({FileName}, {SizeBytes} bytes, ttl {Ttl})",
                releaseId, file.FileName, file.SizeBytes, session.TimeToLive);
            return active;
        }
    }

    public bool TryGetSession(string token, out ActiveSession session)
    {
        if (_sessions.TryGetValue(token, out var found) &&
            !found.IsClosed &&
            found.ExpiresAt > DateTimeOffset.UtcNow)
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

        session.Touch();
        try
        {
            return new SessionStream(
                session.File.OpenObservedStream is { } observed
                    ? observed(session.NntpClient, session.RecordChunkRequested)
                    : session.File.OpenStream(session.NntpClient),
                session,
                () => _streamGate.Release());
        }
        catch
        {
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

    /// <summary>Removes sessions whose sliding TTL has lapsed. Returns the count removed.</summary>
    public int SweepExpired()
    {
        var now = DateTimeOffset.UtcNow;
        var removed = 0;
        foreach (var (token, session) in _sessions)
        {
            if (session.ExpiresAt > now)
                continue;
            if (!_sessions.TryRemove(token, out var expired))
                continue;

            expired.MarkClosed();
            metrics?.SessionClosed();
            removed++;
            logger.LogInformation(
                "Expired capability session for release {ReleaseId} (idle past ttl)",
                expired.Session.ReleaseId);
        }

        return removed;
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
/// refreshes the session's sliding TTL on activity, and refuses further reads
/// once the session is closed (teardown cuts off in-flight requests).
/// </summary>
internal sealed class SessionStream(Stream inner, ActiveSession session, Action? onDispose = null) : Stream
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
        var read = await inner.ReadAsync(buffer, cancellationToken);
        if (read > 0)
        {
            session.AddBytesServed(read);
            session.Touch();
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

/// <summary>A configured, retryable process/session/stream capacity was reached.</summary>
public sealed class ResourceCapacityException(string message) : Exception(message);

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
