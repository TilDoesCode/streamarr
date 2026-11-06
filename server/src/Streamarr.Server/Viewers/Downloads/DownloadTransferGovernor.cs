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

/// <summary>The access generations a file request was authorized under; a revocation in between makes it stale.</summary>
public readonly record struct AccessStamp(long Download, long Viewer);

/// <summary>
/// Device-download transfers: how many may run (per download, viewer and server), the shared bandwidth all of them get — held to
/// <c>bandwidthWhileStreamingKbps</c> (0 = paused) while a live stream plays, <c>bandwidthKbps</c> (0 = unlimited) otherwise — their
/// measured speed, and their access: a revocation bumps the download's or viewer's generation and ends its open requests.
/// </summary>
public sealed class DownloadTransferGovernor(Func<ViewerDownloadSettings> settings, ILiveStreamSignal live)
{
    public const int MaxRequestsPerDownload = 2;

    /// <summary>Scope of a <see cref="TryAdmit"/> refusal whose authorization went stale.</summary>
    public const string Revoked = "revoked";

    // Seconds of rate the shared bucket may bank, so short gaps (TCP back-pressure) do not lose rate.
    private const double BurstSeconds = 0.5;
    private static readonly TimeSpan MaxWaitSlice = TimeSpan.FromMilliseconds(250);
    private const int MeterSeconds = 5;

    private readonly object _lock = new();
    private readonly Dictionary<string, Transfer> _transfers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _downloadGenerations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _viewerGenerations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Meter> _meters = new(StringComparer.Ordinal);
    private readonly Meter _total = new();
    private double _tokens = double.NaN;
    private double _refilledAt;

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

    /// <summary>The downloads of a viewer with an open request, and their works.</summary>
    public IReadOnlyList<(string DownloadId, string WorkId)> ActiveOf(string viewerId)
    {
        lock (_lock)
            return _transfers.Values.Where(t => t.ViewerId == viewerId).Select(t => (t.DownloadId, t.WorkId)).ToList();
    }

    public bool IsTransferring(string downloadId)
    {
        lock (_lock)
            return _transfers.ContainsKey(downloadId);
    }

    public bool Throttled => live.Active;

    public int LiveStreams => live.LiveStreams;

    /// <summary>Read before the authoritative state: a revocation commits its state first and bumps the generation after.</summary>
    public AccessStamp Stamp(string downloadId, string viewerId)
    {
        lock (_lock)
            return new AccessStamp(_downloadGenerations.GetValueOrDefault(downloadId), _viewerGenerations.GetValueOrDefault(viewerId));
    }

    /// <summary>
    /// Admits one file request of a download authorized under <paramref name="stamp"/>, or says why not: <c>revoked</c> (access changed
    /// since), <c>download</c>, <c>viewer</c> or <c>server</c> (a limit). <paramref name="viewerLimit"/> is the viewer's own limit
    /// (null = the server default); the lease ends by itself at <paramref name="deadline"/> (the capability's expiry).
    /// </summary>
    public TransferLease? TryAdmit(
        string downloadId, string viewerId, string workId, int? viewerLimit, AccessStamp stamp, DateTimeOffset? deadline, CancellationToken requestAborted,
        out string? limitScope)
    {
        var current = Settings;
        lock (_lock)
        {
            if (stamp != new AccessStamp(_downloadGenerations.GetValueOrDefault(downloadId), _viewerGenerations.GetValueOrDefault(viewerId)))
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
            var lease = new TransferLease(this, downloadId, requestAborted) { Deadline = deadline };
            running.Leases.Add(lease);
            limitScope = null;
            return lease;
        }
    }

    /// <summary>Ends every open request of a download and invalidates authorizations in flight (revoked, deleted, completed, rotated).</summary>
    public void Abort(string downloadId)
    {
        List<TransferLease> leases;
        lock (_lock)
        {
            _downloadGenerations[downloadId] = _downloadGenerations.GetValueOrDefault(downloadId) + 1;
            leases = _transfers.TryGetValue(downloadId, out var running) ? [.. running.Leases] : [];
        }
        foreach (var lease in leases)
            lease.Abort();
    }

    /// <summary>Invalidates the viewer's authorizations in flight; with <paramref name="endTransfers"/> also ends every open request of the viewer.</summary>
    public void RevokeViewer(string viewerId, bool endTransfers)
    {
        List<TransferLease> leases;
        lock (_lock)
        {
            _viewerGenerations[viewerId] = _viewerGenerations.GetValueOrDefault(viewerId) + 1;
            leases = endTransfers ? _transfers.Values.Where(t => t.ViewerId == viewerId).SelectMany(t => t.Leases).ToList() : [];
        }
        foreach (var lease in leases)
            lease.Abort();
    }

    /// <summary>A renewal moves the deadline of the download's open requests.</summary>
    public void SetDeadline(string downloadId, DateTimeOffset? deadline)
    {
        lock (_lock)
        {
            if (_transfers.TryGetValue(downloadId, out var running))
                foreach (var lease in running.Leases)
                    lease.Deadline = deadline;
        }
    }

    /// <summary>Ends the open requests whose capability expired; answers how many.</summary>
    public int ExpireDue(DateTimeOffset now)
    {
        List<TransferLease> due;
        lock (_lock)
            due = _transfers.Values.SelectMany(t => t.Leases).Where(l => l.Deadline is { } deadline && deadline <= now).ToList();
        foreach (var lease in due)
            lease.Abort();
        return due.Count;
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

    /// <summary>
    /// Waits until the shared bandwidth allows <paramref name="bytes"/> more, then takes them: a token bucket that charges only granted
    /// bytes (a cancelled wait costs nothing) and re-reads the rate while waiting (a pause waits for the live streams to end).
    /// </summary>
    public async ValueTask ThrottleAsync(int bytes, CancellationToken ct)
    {
        while (true)
        {
            var rate = CurrentRate();
            if (rate is null)
                return;
            var wait = MaxWaitSlice;
            if (rate > 0)
            {
                lock (_lock)
                {
                    var now = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
                    var capacity = Math.Max(rate.Value * BurstSeconds, bytes);
                    _tokens = double.IsNaN(_tokens) ? capacity : Math.Min(capacity, _tokens + (now - _refilledAt) * rate.Value);
                    _refilledAt = now;
                    if (_tokens >= bytes)
                    {
                        _tokens -= bytes;
                        return;
                    }
                    var needed = TimeSpan.FromSeconds((bytes - _tokens) / rate.Value);
                    if (needed < wait)
                        wait = needed;
                }
            }
            await Task.Delay(wait < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : wait, ct);
        }
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

/// <summary>One admitted file request; disposing it frees the slot. <see cref="Token"/> ends when the request or the download is aborted.</summary>
public sealed class TransferLease : IDisposable
{
    private readonly DownloadTransferGovernor _owner;
    private readonly CancellationTokenSource _abort;
    private int _disposed;

    internal TransferLease(DownloadTransferGovernor owner, string downloadId, CancellationToken requestAborted)
    {
        _owner = owner;
        DownloadId = downloadId;
        _abort = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
    }

    public string DownloadId { get; }

    public CancellationToken Token => _abort.Token;

    /// <summary>When the capability expires (the lease is aborted then); guarded by the governor's lock.</summary>
    internal DateTimeOffset? Deadline { get; set; }

    internal void Abort()
    {
        try
        {
            _abort.Cancel();
        }
        catch (ObjectDisposedException)
        {
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
