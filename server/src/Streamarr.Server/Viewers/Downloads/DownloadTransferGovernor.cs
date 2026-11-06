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

/// <summary>
/// Device-download transfers: how many may run (per download, viewer and server), the shared bandwidth all of them get — held to
/// <c>bandwidthWhileStreamingKbps</c> (0 = paused) while a live stream plays, <c>bandwidthKbps</c> (0 = unlimited) otherwise — and
/// their measured speed.
/// </summary>
public sealed class DownloadTransferGovernor(Func<ViewerDownloadSettings> settings, ILiveStreamSignal live)
{
    public const int MaxRequestsPerDownload = 2;

    // Bytes of burst the shared bucket may bank, so short gaps (TCP back-pressure) do not lose rate.
    private const double BurstSeconds = 0.5;
    private static readonly TimeSpan PausePoll = TimeSpan.FromMilliseconds(250);
    private const int MeterSeconds = 5;

    private readonly object _lock = new();
    private readonly Dictionary<string, Transfer> _transfers = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Meter> _meters = new(StringComparer.Ordinal);
    private readonly Meter _total = new();
    private double _bucketClock;

    private sealed class Transfer(string downloadId, string viewerId)
    {
        public string DownloadId { get; } = downloadId;
        public string ViewerId { get; } = viewerId;
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

    public bool IsTransferring(string downloadId)
    {
        lock (_lock)
            return _transfers.ContainsKey(downloadId);
    }

    public bool Throttled => live.Active;

    public int LiveStreams => live.LiveStreams;

    /// <summary>
    /// Admits one file request of a download, or says which limit is reached (<c>download</c>, <c>viewer</c>, <c>server</c>);
    /// <paramref name="viewerLimit"/> is the viewer's own limit (null = the server default).
    /// </summary>
    public TransferLease? TryAdmit(string downloadId, string viewerId, int? viewerLimit, CancellationToken requestAborted, out string? limitScope)
    {
        var current = Settings;
        lock (_lock)
        {
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
                running = new Transfer(downloadId, viewerId);
                _transfers[downloadId] = running;
            }
            var lease = new TransferLease(this, downloadId, requestAborted);
            running.Leases.Add(lease);
            limitScope = null;
            return lease;
        }
    }

    /// <summary>Ends every open request of a download (revoked, deleted, completed).</summary>
    public void Abort(string downloadId)
    {
        List<TransferLease> leases;
        lock (_lock)
            leases = _transfers.TryGetValue(downloadId, out var running) ? [.. running.Leases] : [];
        foreach (var lease in leases)
            lease.Abort();
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

    /// <summary>Waits until the shared bandwidth allows <paramref name="bytes"/> more; a pause waits for the live streams to end.</summary>
    public async ValueTask ThrottleAsync(int bytes, CancellationToken ct)
    {
        while (true)
        {
            var rate = CurrentRate();
            if (rate is null)
                return;
            if (rate > 0)
            {
                TimeSpan wait;
                lock (_lock)
                {
                    var now = Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
                    _bucketClock = Math.Max(_bucketClock, now - BurstSeconds) + bytes / rate.Value;
                    wait = TimeSpan.FromSeconds(Math.Max(0, _bucketClock - now));
                }
                if (wait > TimeSpan.FromMilliseconds(1))
                    await Task.Delay(wait, ct);
                return;
            }
            await Task.Delay(PausePoll, ct);
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
