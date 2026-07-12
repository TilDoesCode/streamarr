using System.Collections.Concurrent;

namespace Streamarr.Core.Tmdb;

/// <summary>
/// Aggressive in-memory caching decorator for <see cref="ITmdbClient"/> (BRIEF §6.1
/// module 3: "cache aggressively"). Caches both hits and misses (negative caching) for
/// <see cref="TmdbOptions.CacheTtl"/>, and shares the in-flight <see cref="Task"/> so
/// concurrent lookups for the same key collapse to one upstream call. Thread-safe.
/// </summary>
public sealed class CachingTmdbClient(ITmdbClient inner, TimeSpan ttl, TimeProvider? timeProvider = null) : ITmdbClient
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.Ordinal);

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-movie|{title.ToLowerInvariant()}|{year}", ct => inner.SearchMovieAsync(title, year, ct), cancellationToken);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-tv|{title.ToLowerInvariant()}", ct => inner.SearchTvAsync(title, ct), cancellationToken);

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"movie|{tmdbId}", ct => inner.GetMovieAsync(tmdbId, ct), cancellationToken);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"tv|{tmdbId}", ct => inner.GetTvAsync(tmdbId, ct), cancellationToken);

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"imdb|{imdbId.ToLowerInvariant()}", ct => inner.FindByImdbAsync(imdbId, ct), cancellationToken);

    private Task<TmdbMatch?> GetOrAddAsync(string key, Func<CancellationToken, Task<TmdbMatch?>> factory, CancellationToken cancellationToken)
    {
        var now = _time.GetUtcNow();
        if (_cache.TryGetValue(key, out var existing) && existing.ExpiresAt > now && !IsFaulted(existing.Task))
            return existing.Task;

        // Detach from the caller's cancellation so a cached entry is never a cancelled
        // task; a single caller cancelling must not poison the shared cache slot.
        var task = factory(CancellationToken.None);
        var entry = new Entry(task, now + ttl);
        _cache[key] = entry;

        _ = task.ContinueWith(
            t =>
            {
                if (t.IsFaulted)
                    _cache.TryRemove(new KeyValuePair<string, Entry>(key, entry));
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return task.WaitAsync(cancellationToken);
    }

    private static bool IsFaulted(Task<TmdbMatch?> task) => task.IsFaulted || task.IsCanceled;

    private readonly record struct Entry(Task<TmdbMatch?> Task, DateTimeOffset ExpiresAt);
}
