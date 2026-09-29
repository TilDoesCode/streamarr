using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>A cached ranking result and whether this caller computed it.</summary>
public sealed record CachedLookup<T>(T Value, DateTimeOffset CheckedAt, bool FromCache);

/// <summary>Short-lived single-flight cache of indexer-backed rankings; failures and non-cacheable results are never kept, refreshes are coalesced.</summary>
public sealed class ViewerVersionCache(IOptions<StreamarrOptions> options, TimeProvider time)
{
    private const int MaxEntries = 512;

    /// <summary>A refresh joins a running search and reuses a result younger than this, so looping clients cannot fan out to the indexers.</summary>
    public static readonly TimeSpan MinRefreshAge = TimeSpan.FromSeconds(60);
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly TimeSpan _ttl = TimeSpan.FromSeconds(Math.Max(0, options.Value.ViewerVersionsCacheSeconds));

    public async Task<CachedLookup<T>> GetAsync<T>(
        string key,
        bool refresh,
        Func<CancellationToken, Task<T>> compute,
        Func<T, bool> cacheable,
        CancellationToken ct) where T : class
    {
        var now = time.GetUtcNow();
        Entry? entry = null;
        if (_entries.TryGetValue(key, out var existing))
        {
            if (!existing.Task.IsCompleted || (existing.ExpiresAt > now && (!refresh || now - existing.CheckedAt < MinRefreshAge)))
                entry = existing;
            else
                _entries.TryRemove(new KeyValuePair<string, Entry>(key, existing));
        }

        var created = false;
        if (entry is null)
        {
            Prune(now);
            var fresh = new Entry(RunAsync(key, compute, cacheable), now + _ttl);
            entry = _entries.GetOrAdd(key, fresh);
            created = ReferenceEquals(entry, fresh);
            if (created)
                fresh.Start();
        }

        var value = await entry.Task.WaitAsync(ct);
        return new CachedLookup<T>((T)value!, entry.CheckedAt ?? now, FromCache: !created);
    }

    /// <summary>A completed, unexpired value without computing one.</summary>
    public T? TryPeek<T>(string key) where T : class
        => _entries.TryGetValue(key, out var entry) && entry.Task.IsCompletedSuccessfully && entry.ExpiresAt > time.GetUtcNow()
            ? entry.Task.Result as T
            : null;

    private Func<Entry, Task<object?>> RunAsync<T>(string key, Func<CancellationToken, Task<T>> compute, Func<T, bool> cacheable)
        where T : class
        => async entry =>
        {
            try
            {
                var value = await compute(CancellationToken.None);
                entry.CheckedAt = time.GetUtcNow();
                if (!cacheable(value) || _ttl <= TimeSpan.Zero)
                    _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
                return value;
            }
            catch
            {
                _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));
                throw;
            }
        };

    private void Prune(DateTimeOffset now)
    {
        foreach (var pair in _entries)
        {
            if (pair.Value.Task.IsCompleted && pair.Value.ExpiresAt <= now)
                _entries.TryRemove(pair);
        }
        while (_entries.Count >= MaxEntries)
        {
            var oldest = _entries.Where(p => p.Value.Task.IsCompleted).MinBy(p => p.Value.ExpiresAt);
            if (oldest.Key is null || !_entries.TryRemove(oldest))
                break;
        }
    }

    private sealed class Entry(Func<Entry, Task<object?>> run, DateTimeOffset expiresAt)
    {
        private readonly TaskCompletionSource<object?> _completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<object?> Task => _completion.Task;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public DateTimeOffset? CheckedAt { get; set; }

        public void Start()
        {
            _ = RunToCompletionAsync();
            _ = Task.ContinueWith(static t => _ = t.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
        }

        private async Task RunToCompletionAsync()
        {
            try
            {
                _completion.TrySetResult(await run(this));
            }
            catch (Exception e)
            {
                _completion.TrySetException(e);
            }
        }
    }
}
