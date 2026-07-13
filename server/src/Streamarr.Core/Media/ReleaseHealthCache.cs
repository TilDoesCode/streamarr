using System.Collections.Concurrent;

namespace Streamarr.Core.Media;

/// <summary>
/// Remembers the health classification of releases seen at resolve time so it can be
/// fed back into ranking and fallback selection (BRIEF §6.1 module 5 / §7.2, §10-M7).
/// A release the health checker found <see cref="ReleaseHealth.Dead"/> stays demoted
/// (and is skipped as a fallback) for the cache TTL, even across re-searches that
/// re-register it fresh from the indexer. Thread-safe.
/// </summary>
public interface IReleaseHealthCache
{
    /// <summary>Record the latest health classification for a release.</summary>
    void Record(string releaseId, ReleaseHealth health);

    /// <summary>The cached classification, or null if unknown / expired.</summary>
    ReleaseHealth? Get(string releaseId);

    /// <summary>True when the release is cached as <see cref="ReleaseHealth.Dead"/>.</summary>
    bool IsDead(string releaseId);
}

/// <summary>In-memory, TTL'd implementation of <see cref="IReleaseHealthCache"/>.</summary>
public sealed class ReleaseHealthCache(TimeSpan ttl, TimeProvider? timeProvider = null) : IReleaseHealthCache
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public void Record(string releaseId, ReleaseHealth health)
    {
        if (string.IsNullOrEmpty(releaseId) || ttl <= TimeSpan.Zero)
            return;
        _entries[releaseId] = new Entry(health, _time.GetUtcNow() + ttl);
    }

    public ReleaseHealth? Get(string releaseId)
    {
        if (_entries.TryGetValue(releaseId, out var entry))
        {
            if (entry.ExpiresAtUtc > _time.GetUtcNow())
                return entry.Health;

            // lazily evict so a fresh resolve re-classifies
            _entries.TryRemove(new KeyValuePair<string, Entry>(releaseId, entry));
        }

        return null;
    }

    public bool IsDead(string releaseId) => Get(releaseId) == ReleaseHealth.Dead;

    private readonly record struct Entry(ReleaseHealth Health, DateTimeOffset ExpiresAtUtc);
}
