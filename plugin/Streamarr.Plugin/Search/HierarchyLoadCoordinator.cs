using System.Collections.Concurrent;

namespace Streamarr.Plugin.Search;

/// <summary>
/// Coalesces cold Core hierarchy fetches. A keyed lease retains the completed response until every
/// participating caller has finished its caller-specific materialization, closing the gap where a
/// later cold request could otherwise start a second indexer fan-out before the completion marker
/// was committed. A request abort only stops that waiter; the shared fetch has its own hard deadline.
/// </summary>
public sealed class HierarchyLoadCoordinator
{
    public readonly record struct Key(int TmdbId, int? SeasonNumber);

    private readonly ConcurrentDictionary<Key, Entry> _loads = new();

    internal int ActiveLoadCount => _loads.Count;

    /// <summary>
    /// Acquires the key before the caller rechecks hierarchy completeness. The fetch is lazy, so a
    /// hierarchy that became complete just before this lease was acquired can release it without
    /// making another Core request.
    /// </summary>
    public FetchLease<T> Acquire<T>(
        Key key,
        TimeSpan timeout,
        Func<CancellationToken, Task<T?>> fetch)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(fetch);
        if (timeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(timeout));

        while (true)
        {
            var candidate = new Entry(
                this,
                key,
                typeof(T),
                timeout,
                async cancellationToken => await fetch(cancellationToken).ConfigureAwait(false));
            var entry = _loads.GetOrAdd(key, candidate);
            if (entry.ResultType != typeof(T))
            {
                throw new InvalidOperationException(
                    $"Hierarchy key {key} was reused for incompatible response types "
                    + $"{entry.ResultType.Name} and {typeof(T).Name}.");
            }

            if (entry.TryAcquire())
                return new FetchLease<T>(entry);
        }
    }

    private void Remove(Key key, Entry owner)
        => ((ICollection<KeyValuePair<Key, Entry>>)_loads)
            .Remove(new KeyValuePair<Key, Entry>(key, owner));

    internal sealed class Entry
    {
        private readonly HierarchyLoadCoordinator _owner;
        private readonly Key _key;
        private readonly TimeSpan _timeout;
        private readonly object _sync = new();
        private readonly Lazy<Task<object?>> _fetch;
        private int _leases;
        private bool _fetchCompleted;
        private bool _retired;

        public Entry(
            HierarchyLoadCoordinator owner,
            Key key,
            Type resultType,
            TimeSpan timeout,
            Func<CancellationToken, Task<object?>> fetch)
        {
            _owner = owner;
            _key = key;
            ResultType = resultType;
            _timeout = timeout;
            _fetch = new Lazy<Task<object?>>(
                async () =>
                {
                    try
                    {
                        using var timeoutSource = new CancellationTokenSource(_timeout);
                        return await fetch(timeoutSource.Token).ConfigureAwait(false);
                    }
                    finally
                    {
                        OnFetchCompleted();
                    }
                },
                LazyThreadSafetyMode.ExecutionAndPublication);
        }

        public Type ResultType { get; }

        public bool TryAcquire()
        {
            lock (_sync)
            {
                if (_retired)
                    return false;
                _leases++;
                return true;
            }
        }

        public async Task<T?> FetchAsync<T>(CancellationToken waiterCancellationToken)
            where T : class
        {
            // This is a non-cooperative request bound. The shared operation remains registered
            // until it actually stops, preventing a timed-out caller from overlapping the fetch.
            var result = await _fetch.Value
                .WaitAsync(_timeout, waiterCancellationToken)
                .ConfigureAwait(false);
            return result switch
            {
                null => null,
                T typed => typed,
                _ => throw new InvalidOperationException(
                    $"Hierarchy key {_key} returned {result.GetType().Name}, expected {typeof(T).Name}."),
            };
        }

        public void Release()
        {
            var remove = false;
            lock (_sync)
            {
                if (_leases <= 0)
                    return;
                _leases--;
                if (_leases == 0 && (!_fetch.IsValueCreated || _fetchCompleted))
                {
                    _retired = true;
                    remove = true;
                }
            }

            if (remove)
                _owner.Remove(_key, this);
        }

        private void OnFetchCompleted()
        {
            var remove = false;
            lock (_sync)
            {
                _fetchCompleted = true;
                if (_leases == 0)
                {
                    _retired = true;
                    remove = true;
                }
            }

            if (remove)
                _owner.Remove(_key, this);
        }
    }

    public sealed class FetchLease<T> : IDisposable
        where T : class
    {
        private Entry? _entry;

        internal FetchLease(Entry entry)
        {
            _entry = entry;
        }

        public Task<T?> FetchAsync(CancellationToken waiterCancellationToken)
            => _entry?.FetchAsync<T>(waiterCancellationToken)
               ?? throw new ObjectDisposedException(nameof(FetchLease<T>));

        public void Dispose()
            => Interlocked.Exchange(ref _entry, null)?.Release();
    }
}
