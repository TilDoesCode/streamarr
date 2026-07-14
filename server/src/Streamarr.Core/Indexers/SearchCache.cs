using System.Collections.Concurrent;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Short-lived (~60s) in-memory cache of fan-out search results keyed by the
/// normalized query (BRIEF §6.1 module 1). Absorbs the burst of identical
/// searches a client issues while the user types/retries. Thread-safe.
/// </summary>
public sealed class SearchCache(TimeSpan ttl, TimeProvider? timeProvider = null, int maxEntries = 1_000)
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private long _hits;
    private long _misses;

    /// <summary>Cumulative cache hits (BRIEF §10-M7 observability: cache hit rate).</summary>
    public long Hits => Interlocked.Read(ref _hits);

    /// <summary>Cumulative cache misses.</summary>
    public long Misses => Interlocked.Read(ref _misses);

    public bool TryGet(string key, out IndexerSearchResult result)
    {
        if (_entries.TryGetValue(key, out var entry) && entry.ExpiresAtUtc > _time.GetUtcNow())
        {
            Interlocked.Increment(ref _hits);
            result = entry.Result;
            return true;
        }

        Interlocked.Increment(ref _misses);

        // lazily evict the stale entry so a fresh search re-runs the fan-out
        if (entry is not null)
            _entries.TryRemove(new KeyValuePair<string, Entry>(key, entry));

        result = default!;
        return false;
    }

    public void Set(string key, IndexerSearchResult result)
    {
        if (ttl <= TimeSpan.Zero)
            return;

        var now = _time.GetUtcNow();
        Prune(now);
        _entries[key] = new Entry(result, now + ttl);
        TrimToLimit();
    }

    public int Count
    {
        get
        {
            Prune(_time.GetUtcNow());
            return _entries.Count;
        }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var pair in _entries)
        {
            if (pair.Value.ExpiresAtUtc <= now)
                _entries.TryRemove(pair);
        }
    }

    private void TrimToLimit()
    {
        var limit = Math.Max(1, maxEntries);
        while (_entries.Count > limit)
        {
            var oldest = _entries.MinBy(p => p.Value.ExpiresAtUtc);
            if (oldest.Key is null || !_entries.TryRemove(oldest))
                break;
        }
    }

    private sealed record Entry(IndexerSearchResult Result, DateTimeOffset ExpiresAtUtc);
}
