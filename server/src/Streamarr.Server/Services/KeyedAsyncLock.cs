namespace Streamarr.Server.Services;

/// <summary>
/// A small reference-counted keyed mutex. Acquiring and retiring entries share one short
/// bookkeeping lock, so a waiter can never retain an old semaphore after it was removed from the
/// key map. That hand-off race would otherwise allow two expensive cache fills for the same key.
/// </summary>
internal sealed class KeyedAsyncLock
{
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    internal int ActiveKeyCount
    {
        get
        {
            lock (_gate)
                return _entries.Count;
        }
    }

    public async ValueTask<IDisposable> AcquireAsync(string key, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);

        Entry entry;
        lock (_gate)
        {
            if (!_entries.TryGetValue(key, out entry!))
            {
                entry = new Entry();
                _entries.Add(key, entry);
            }

            entry.ReferenceCount++;
        }

        try
        {
            await entry.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            return new Lease(this, key, entry);
        }
        catch
        {
            ReleaseReference(key, entry);
            throw;
        }
    }

    private void Release(string key, Entry entry)
    {
        entry.Semaphore.Release();
        ReleaseReference(key, entry);
    }

    private void ReleaseReference(string key, Entry entry)
    {
        lock (_gate)
        {
            entry.ReferenceCount--;
            if (entry.ReferenceCount != 0)
                return;

            if (_entries.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                _entries.Remove(key);
            entry.Semaphore.Dispose();
        }
    }

    private sealed class Entry
    {
        public readonly SemaphoreSlim Semaphore = new(1, 1);
        public int ReferenceCount;
    }

    private sealed class Lease(KeyedAsyncLock owner, string key, Entry entry) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                owner.Release(key, entry);
        }
    }
}
