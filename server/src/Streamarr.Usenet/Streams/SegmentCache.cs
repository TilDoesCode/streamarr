using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Streams;

/// <summary>
/// Process-wide, size-bounded LRU cache for fully decoded NNTP articles. Concurrent
/// callers requesting the same message-id share one download.
/// </summary>
public sealed class SegmentCache : IDisposable
{
    private sealed record Entry(byte[] Bytes, LinkedListNode<string> LruNode);

    private readonly object _sync = new();
    private readonly long _capacityBytes;
    private readonly CancellationTokenSource _disposeCts = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<byte[]>> _inFlight = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _lru = new();
    private long _sizeBytes;
    private bool _disposed;

    public SegmentCache(long capacityBytes)
    {
        if (capacityBytes < 0) throw new ArgumentOutOfRangeException(nameof(capacityBytes));
        _capacityBytes = capacityBytes;
    }

    public long CapacityBytes => _capacityBytes;
    internal CancellationToken LifetimeToken => _disposeCts.Token;

    public bool TryGet(string segmentId, out byte[] bytes)
    {
        var key = SegmentId.Normalize(segmentId);
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_entries.TryGetValue(key, out var cached))
            {
                Touch(cached);
                bytes = cached.Bytes;
                return true;
            }
        }

        bytes = [];
        return false;
    }

    public void Store(string segmentId, byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        var key = SegmentId.Normalize(segmentId);
        if (_capacityBytes == 0 || bytes.LongLength > _capacityBytes)
            return;

        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_entries.ContainsKey(key))
                return;
            while (_sizeBytes > _capacityBytes - bytes.LongLength && _lru.First is { } oldest)
                Remove(oldest.Value);
            var node = _lru.AddLast(key);
            _entries.Add(key, new Entry(bytes, node));
            _sizeBytes += bytes.LongLength;
        }
    }

    public (int Count, long Bytes) GetStats(IEnumerable<string> segmentIds)
    {
        ArgumentNullException.ThrowIfNull(segmentIds);
        var count = 0;
        long bytes = 0;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            foreach (var key in segmentIds.Select(SegmentId.Normalize).Distinct(StringComparer.Ordinal))
            {
                if (!_entries.TryGetValue(key, out var entry))
                    continue;
                count++;
                bytes += entry.Bytes.LongLength;
            }
        }
        return (count, bytes);
    }

    public Task<byte[]> GetOrAddAsync(
        string segmentId,
        Func<CancellationToken, Task<byte[]>> factory,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(factory);
        var key = SegmentId.Normalize(segmentId);

        if (_capacityBytes == 0)
            return factory(cancellationToken);

        Task<byte[]> task;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_entries.TryGetValue(key, out var cached))
            {
                Touch(cached);
                return Task.FromResult(cached.Bytes);
            }

            if (!_inFlight.TryGetValue(key, out task!))
            {
                // A single caller cancelling an overlapping Range request must not abort
                // the shared transfer for every other waiter.
                task = factory(_disposeCts.Token);
                _inFlight.Add(key, task);
                _ = CompleteAsync(key, task);
            }
        }

        return WaitAsync(task, cancellationToken);
    }

    private static async Task<byte[]> WaitAsync(Task<byte[]> task, CancellationToken cancellationToken)
        => await task.WaitAsync(cancellationToken).ConfigureAwait(false);

    private async Task CompleteAsync(string key, Task<byte[]> task)
    {
        byte[]? bytes = null;
        try
        {
            bytes = await task.ConfigureAwait(false);
        }
        catch
        {
            // The original waiter observes the exception. A later request may retry.
        }

        lock (_sync)
        {
            if (_inFlight.TryGetValue(key, out var current) && ReferenceEquals(current, task))
                _inFlight.Remove(key);

            if (_disposed
                || bytes is null
                || bytes.LongLength > _capacityBytes
                || _entries.ContainsKey(key))
                return;

            while (_sizeBytes > _capacityBytes - bytes.LongLength && _lru.First is { } oldest)
                Remove(oldest.Value);

            var node = _lru.AddLast(key);
            _entries.Add(key, new Entry(bytes, node));
            _sizeBytes += bytes.LongLength;
        }
    }

    private void Touch(Entry entry)
    {
        _lru.Remove(entry.LruNode);
        _lru.AddLast(entry.LruNode);
    }

    private void Remove(string key)
    {
        if (!_entries.Remove(key, out var entry)) return;
        _lru.Remove(entry.LruNode);
        _sizeBytes -= entry.Bytes.LongLength;
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            _entries.Clear();
            _inFlight.Clear();
            _lru.Clear();
            _sizeBytes = 0;
        }

        _disposeCts.Cancel();
        _disposeCts.Dispose();
    }
}
