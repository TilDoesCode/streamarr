using System.Collections.Concurrent;
using System.Diagnostics;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>Whether live playback streams are running (players, remux/transcode inputs); downloads yield to them.</summary>
public interface ILiveStreamSignal
{
    int LiveStreams { get; }

    bool Active { get; }
}

/// <summary>Live streams as the session manager sees them: open paced stream requests, held for a moment after the last one closed.</summary>
public sealed class SessionLiveStreamSignal(Services.SessionManager sessions) : ILiveStreamSignal
{
    /// <summary>A player between two range requests still counts as live.</summary>
    public static readonly TimeSpan Hold = TimeSpan.FromSeconds(15);

    public int LiveStreams => sessions.LiveStreams;

    public bool Active => sessions.LiveStreamsActive(Hold);
}

/// <summary>The access generations a file request was authorized under (download, viewer, its capability); a revocation in between makes it stale.</summary>
public readonly record struct AccessStamp(long Download, long Viewer, long Capability);

/// <summary>One admitted file request: its own id, download, viewer, work, the capability it was admitted with and the record revision it read.</summary>
public readonly record struct LeaseRef(long Id, string DownloadId, string ViewerId, string WorkId, string CapabilityHash, long AdmittedRevision);

/// <summary>
/// Device-download transfers: how many may run (per download, viewer and server), the shared bandwidth all of them get — held to
/// <c>bandwidthWhileStreamingKbps</c> (0 = paused) while a live stream plays, <c>bandwidthKbps</c> (0 = unlimited) otherwise — their
/// measured speed, and their access: a revocation bumps the download's or viewer's generation and ends its open requests.
/// </summary>
public sealed class DownloadTransferGovernor(
    Func<ViewerDownloadSettings> settings, ILiveStreamSignal live, ILogger<DownloadTransferGovernor>? logger = null)
{
    public const int MaxRequestsPerDownload = 2;

    /// <summary>Scope of a <see cref="TryAdmit"/> refusal whose authorization went stale.</summary>
    public const string Revoked = "revoked";

    // The shared bucket holds a second of the rate, and never less than one transfer chunk, so every request size can be granted.
    private const double CapacitySeconds = 1;
    private static readonly TimeSpan MaxWaitSlice = TimeSpan.FromMilliseconds(250);
    private const int MeterSeconds = 5;

    private readonly object _lock = new();
    private readonly Dictionary<string, Transfer> _transfers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _downloadGenerations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _viewerGenerations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _capabilityGenerations = new(StringComparer.Ordinal);
    private long _nextLeaseId;
    private readonly ConcurrentDictionary<string, Meter> _meters = new(StringComparer.Ordinal);
    private readonly Meter _total = new();
    private double _tokens = double.NaN;
    private double _refilledAt;
    private readonly LinkedList<int> _waiters = new();
    private TaskCompletionSource _turn = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class Transfer(string downloadId, string viewerId, string workId)
    {
        public string DownloadId { get; } = downloadId;
        public string ViewerId { get; } = viewerId;
        public string WorkId { get; } = workId;
        public List<TransferLease> Leases { get; } = [];
    }

    public ViewerDownloadSettings Settings => settings();

    /// <summary>Downloads with an open file request right now.</summary>
    public int ActiveTransfers
    {
        get
        {
            lock (_lock)
                return _transfers.Count;
        }
    }

    public int ActiveFor(string viewerId)
    {
        lock (_lock)
            return _transfers.Values.Count(t => t.ViewerId == viewerId);
    }

    /// <summary>Every open request right now (a snapshot: requests admitted later are not in it).</summary>
    public IReadOnlyList<LeaseRef> ActiveLeases()
    {
        lock (_lock)
            return _transfers.Values.SelectMany(t => t.Leases.Select(l => l.Ref)).ToList();
    }

    public bool IsTransferring(string downloadId)
    {
        lock (_lock)
            return _transfers.ContainsKey(downloadId);
    }

    public bool Throttled => live.Active;

    public int LiveStreams => live.LiveStreams;

    /// <summary>Read before the authoritative state: a revocation commits its state first and bumps the generation after.</summary>
    public AccessStamp Stamp(string downloadId, string viewerId, string capabilityHash)
    {
        lock (_lock)
            return CurrentStamp(downloadId, viewerId, capabilityHash);
    }

    private AccessStamp CurrentStamp(string downloadId, string viewerId, string capabilityHash)
        => new(_downloadGenerations.GetValueOrDefault(downloadId), _viewerGenerations.GetValueOrDefault(viewerId),
            _capabilityGenerations.GetValueOrDefault(capabilityHash));

    /// <summary>
    /// Admits one file request of a download authorized under <paramref name="stamp"/> with <paramref name="capabilityHash"/> after reading the
    /// record at <paramref name="revision"/>, or says why not: <c>revoked</c> (access changed since), <c>download</c>, <c>viewer</c> or
    /// <c>server</c> (a limit). <paramref name="viewerLimit"/> is the viewer's own limit (null = the server default); the lease ends by
    /// itself at <paramref name="deadline"/> (the capability's expiry).
    /// </summary>
    public TransferLease? TryAdmit(
        string downloadId, string viewerId, string workId, int? viewerLimit, AccessStamp stamp, DateTimeOffset? deadline, CancellationToken requestAborted,
        out string? limitScope, string capabilityHash, long revision = 0)
    {
        var current = Settings;
        lock (_lock)
        {
            if (stamp != CurrentStamp(downloadId, viewerId, capabilityHash))
            {
                limitScope = Revoked;
                return null;
            }
            if (_transfers.TryGetValue(downloadId, out var running))
            {
                if (running.Leases.Count >= MaxRequestsPerDownload)
                {
                    limitScope = "download";
                    return null;
                }
            }
            else
            {
                if (_transfers.Values.Count(t => t.ViewerId == viewerId) >= (viewerLimit ?? current.MaxActivePerViewer))
                {
                    limitScope = "viewer";
                    return null;
                }
                if (_transfers.Count >= current.MaxActiveGlobal)
                {
                    limitScope = "server";
                    return null;
                }
                running = new Transfer(downloadId, viewerId, workId);
                _transfers[downloadId] = running;
            }
            var lease = new TransferLease(this, new LeaseRef(++_nextLeaseId, downloadId, viewerId, workId, capabilityHash, revision), requestAborted)
            {
                Deadline = deadline,
            };
            running.Leases.Add(lease);
            limitScope = null;
            return lease;
        }
    }

    /// <summary>
    /// A capability was retired (security sign-out, or found retired by the sweep): requests admitted with it end, authorizations in flight
    /// with it go stale. Requests of the same download on another capability (a renewed URL) are untouched. Answers how many ended.
    /// </summary>
    public int RetireCapability(string downloadId, string capabilityHash)
    {
        List<TransferLease> leases;
        lock (_lock)
        {
            _capabilityGenerations[capabilityHash] = _capabilityGenerations.GetValueOrDefault(capabilityHash) + 1;
            leases = _transfers.TryGetValue(downloadId, out var running)
                ? running.Leases.Where(l => string.Equals(l.Ref.CapabilityHash, capabilityHash, StringComparison.Ordinal)).ToList()
                : [];
        }
        return AbortAll(leases);
    }

    /// <summary>
    /// The download ended for good (deleted, completed, revoked by an admin) at record <paramref name="revision"/>, read inside the change's
    /// transaction: every request admitted at or before it ends, authorizations in flight go stale. Answers how many ended.
    /// </summary>
    public int EndDownload(string downloadId, long revision)
    {
        List<TransferLease> leases;
        lock (_lock)
        {
            _downloadGenerations[downloadId] = _downloadGenerations.GetValueOrDefault(downloadId) + 1;
            leases = _transfers.TryGetValue(downloadId, out var running)
                ? running.Leases.Where(l => l.Ref.AdmittedRevision <= revision).ToList()
                : [];
        }
        return AbortAll(leases);
    }

    /// <summary>Ends exactly these requests (a snapshot judged no longer allowed); requests admitted after the snapshot are untouched.</summary>
    public int Cancel(IEnumerable<LeaseRef> leases)
    {
        var wanted = leases.Select(l => l.Id).ToHashSet();
        List<TransferLease> found;
        lock (_lock)
            found = _transfers.Values.SelectMany(t => t.Leases).Where(l => wanted.Contains(l.Ref.Id)).ToList();
        return AbortAll(found);
    }

    /// <summary>The viewer's access changed: authorizations in flight go stale. Answers the viewer's open requests at this moment to judge.</summary>
    public IReadOnlyList<LeaseRef> RevokeViewer(string viewerId)
    {
        lock (_lock)
        {
            _viewerGenerations[viewerId] = _viewerGenerations.GetValueOrDefault(viewerId) + 1;
            return _transfers.Values.Where(t => t.ViewerId == viewerId).SelectMany(t => t.Leases.Select(l => l.Ref)).ToList();
        }
    }

    /// <summary>A renewal moves the deadline of the requests admitted with the renewed capability.</summary>
    public void SetDeadline(string downloadId, string capabilityHash, DateTimeOffset? deadline)
    {
        lock (_lock)
        {
            if (!_transfers.TryGetValue(downloadId, out var running))
                return;
            foreach (var lease in running.Leases.Where(l => string.Equals(l.Ref.CapabilityHash, capabilityHash, StringComparison.Ordinal)))
                lease.Deadline = deadline;
        }
    }

    /// <summary>Ends the open requests whose capability expired; answers how many.</summary>
    public int ExpireDue(DateTimeOffset now)
    {
        List<TransferLease> due;
        lock (_lock)
            due = _transfers.Values.SelectMany(t => t.Leases).Where(l => l.Deadline is { } deadline && deadline <= now).ToList();
        return AbortAll(due);
    }

    /// <summary>
    /// Ends the given requests outside the lock: a request that finished (disposed) since the list was taken is skipped, and one whose
    /// cancellation throws (a callback) never keeps the others alive. Answers how many this call ended.
    /// </summary>
    private int AbortAll(List<TransferLease> leases)
    {
        var ended = 0;
        var failed = 0;
        Exception? firstFailure = null;
        foreach (var lease in leases)
        {
            try
            {
                if (lease.Abort())
                    ended++;
            }
            catch (Exception e)
            {
                failed++;
                firstFailure ??= e;
            }
        }
        if (firstFailure is not null)
            logger?.LogDebug(firstFailure, "Ending {Failed} of {Count} download request(s) raised; the others ended", failed, leases.Count);
        return ended;
    }

    internal void Release(TransferLease lease)
    {
        lock (_lock)
        {
            if (!_transfers.TryGetValue(lease.DownloadId, out var running))
                return;
            running.Leases.Remove(lease);
            if (running.Leases.Count == 0)
                _transfers.Remove(lease.DownloadId);
        }
    }

    /// <summary>Bandwidth all downloads may use now in bytes per second: null = unlimited, 0 = paused.</summary>
    public double? CurrentRate()
    {
        var current = Settings;
        var kbps = live.Active ? current.BandwidthWhileStreamingKbps : current.BandwidthKbps;
        if (!live.Active && kbps == 0)
            return null;
        return kbps * 1000d / 8;
    }

    /// <summary>Bytes the shared bucket can bank at <paramref name="rate"/> bytes per second.</summary>
    public static double Capacity(double rate) => Math.Max(ViewerDownloadFileService.BufferBytes, rate * CapacitySeconds);

    /// <summary>
    /// Waits until the shared bandwidth allows <paramref name="bytes"/> more, then takes them: a token bucket with a stable capacity and a
    /// first-come queue, so a large request is served before smaller ones that arrive after it. Only granted bytes are charged (a cancelled
    /// wait costs nothing and leaves the queue), and the rate is read again while waiting (a pause waits for the live streams to end).
    /// </summary>
    public async ValueTask ThrottleAsync(int bytes, CancellationToken ct)
    {
        LinkedListNode<int>? queued = null;
        try
        {
            while (true)
            {
                var rate = CurrentRate();
                if (rate is null)
                    return;
                var wait = MaxWaitSlice;
                Task turn;
                lock (_lock)
                {
                    if (rate > 0)
                    {
                        var capacity = Capacity(rate.Value);
                        var now = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
                        _tokens = double.IsNaN(_tokens) ? capacity : Math.Min(capacity, _tokens + (now - _refilledAt) * rate.Value);
                        _refilledAt = now;
                        var mine = queued is null ? _waiters.First is null : _waiters.First == queued;
                        var needed = Math.Min(bytes, capacity);
                        if (mine && _tokens >= needed)
                        {
                            _tokens -= bytes;
                            if (queued is not null)
                            {
                                _waiters.Remove(queued);
                                queued = null;
                                NextTurn();
                            }
                            return;
                        }
                        queued ??= _waiters.AddLast(bytes);
                        if (_waiters.First == queued)
                            wait = TimeSpan.FromSeconds(Math.Min(MaxWaitSlice.TotalSeconds, (needed - _tokens) / rate.Value));
                    }
                    else
                    {
                        queued ??= _waiters.AddLast(bytes);
                    }
                    turn = _turn.Task;
                }
                using var delay = CancellationTokenSource.CreateLinkedTokenSource(ct);
                await Task.WhenAny(Task.Delay(wait < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : wait, delay.Token), turn);
                delay.Cancel();
                ct.ThrowIfCancellationRequested();
            }
        }
        finally
        {
            if (queued is not null)
            {
                lock (_lock)
                {
                    var first = _waiters.First == queued;
                    _waiters.Remove(queued);
                    if (first)
                        NextTurn();
                }
            }
        }
    }

    /// <summary>The head of the queue left: the next one re-checks at once (call under the lock).</summary>
    private void NextTurn()
    {
        var turn = _turn;
        _turn = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        turn.TrySetResult();
    }

    public void Record(string downloadId, int bytes)
    {
        _meters.GetOrAdd(downloadId, _ => new Meter()).Add(bytes);
        _total.Add(bytes);
    }

    /// <summary>Bytes per second of one download over the last few seconds.</summary>
    public long Speed(string downloadId) => _meters.TryGetValue(downloadId, out var meter) ? meter.PerSecond() : 0;

    public long TotalSpeed => _total.PerSecond();

    public void Forget(string downloadId) => _meters.TryRemove(downloadId, out _);

    /// <summary>Bytes per whole second over a short window.</summary>
    private sealed class Meter
    {
        private readonly long[] _bytes = new long[MeterSeconds + 1];
        private readonly long[] _second = new long[MeterSeconds + 1];

        public void Add(int bytes)
        {
            var second = Environment.TickCount64 / 1000;
            var slot = (int)(second % _bytes.Length);
            lock (_bytes)
            {
                if (_second[slot] != second)
                {
                    _second[slot] = second;
                    _bytes[slot] = 0;
                }
                _bytes[slot] += bytes;
            }
        }

        public long PerSecond()
        {
            var second = Environment.TickCount64 / 1000;
            long sum = 0;
            lock (_bytes)
            {
                for (var i = 0; i < _bytes.Length; i++)
                {
                    // the current, still filling second is left out
                    if (_second[i] < second && second - _second[i] <= MeterSeconds)
                        sum += _bytes[i];
                }
            }
            return sum / MeterSeconds;
        }
    }
}

/// <summary>
/// One admitted file request; disposing it frees the slot. <see cref="Token"/> ends when the request or the download is aborted. Safe to
/// abort and to read from any thread at any time, also after it was disposed: the token is taken once, and the state is its own flags.
/// </summary>
public sealed class TransferLease : IDisposable
{
    private readonly DownloadTransferGovernor _owner;
    private readonly CancellationTokenSource _abort;
    private readonly CancellationToken _token;
    private int _aborted;
    private int _disposed;

    internal TransferLease(DownloadTransferGovernor owner, LeaseRef identity, CancellationToken requestAborted)
    {
        _owner = owner;
        Ref = identity;
        _abort = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
        _token = _abort.Token;
    }

    /// <summary>Immutable identity: cancellation targets this instance or its capability, never just the download.</summary>
    public LeaseRef Ref { get; }

    public string DownloadId => Ref.DownloadId;

    public CancellationToken Token => _token;

    internal bool IsDisposed => Volatile.Read(ref _disposed) != 0;

    /// <summary>When the capability expires (the lease is aborted then); guarded by the governor's lock.</summary>
    internal DateTimeOffset? Deadline { get; set; }

    /// <summary>
    /// Ends the request once: false when this lease was aborted before or the request already finished (disposed), so it never touches a
    /// disposed source. An exception from a registered callback still propagates (the token is cancelled by then).
    /// </summary>
    internal bool Abort()
    {
        if (Volatile.Read(ref _disposed) != 0 || Interlocked.Exchange(ref _aborted, 1) != 0)
            return false;
        try
        {
            _abort.Cancel();
            return true;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
            return;
        _owner.Release(this);
        _abort.Dispose();
    }
}
