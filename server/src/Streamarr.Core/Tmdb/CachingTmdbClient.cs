using System.Collections.Concurrent;

namespace Streamarr.Core.Tmdb;

/// <summary>
/// Bounded TTL cache that collapses concurrent identical TMDB calls to one shared task.
/// Caller cancellation only cancels that caller's wait, never the shared upstream call.
/// </summary>
public sealed class CachingTmdbClient(
    ITmdbClient inner,
    TimeSpan ttl,
    TimeProvider? timeProvider = null,
    int maxEntries = 5_000,
    int maxConcurrentUpstream = 4,
    TimeSpan? upstreamTimeout = null) : ITmdbClient
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _upstreamGate = new(Math.Max(1, maxConcurrentUpstream));
    private readonly TimeSpan _upstreamTimeout = upstreamTimeout is { } configured && configured > TimeSpan.Zero
        ? configured
        : TimeSpan.FromSeconds(20);

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-any|{query.ToLowerInvariant()}", ct => inner.SearchAnyAsync(query, ct), cancellationToken);

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

    private Task<TmdbMatch?> GetOrAddAsync(
        string key,
        Func<CancellationToken, Task<TmdbMatch?>> factory,
        CancellationToken cancellationToken)
    {
        if (ttl <= TimeSpan.Zero)
            return RunUncachedAsync(factory, cancellationToken);

        while (true)
        {
            var now = _time.GetUtcNow();
            if (_cache.TryGetValue(key, out var existing))
            {
                if (existing.ExpiresAt > now)
                    return Await(existing, key, cancellationToken);
                Remove(key, existing);
            }

            Prune(now);
            var created = CreateEntry(factory, now + ttl);
            var actual = _cache.GetOrAdd(key, created);
            if (!ReferenceEquals(actual, created))
                created.Retire();
            TrimToLimit();
            if (actual.ExpiresAt > now)
                return Await(actual, key, cancellationToken);
        }
    }

    private async Task<TmdbMatch?> Await(Entry entry, string key, CancellationToken ct)
    {
        Task<TmdbMatch?> task;
        try
        {
            task = entry.Task.Value;
        }
        catch
        {
            Remove(key, entry);
            throw;
        }

        try
        {
            return await task.WaitAsync(ct);
        }
        catch (SharedUpstreamTimeoutException)
        {
            Remove(key, entry);
            return null;
        }
        catch when (task.IsFaulted || task.IsCanceled)
        {
            Remove(key, entry);
            throw;
        }
    }

    private Entry CreateEntry(Func<CancellationToken, Task<TmdbMatch?>> factory, DateTimeOffset expiresAt)
    {
        var lifetime = new CancellationTokenSource(_upstreamTimeout);
        return new Entry(
            new Lazy<Task<TmdbMatch?>>(
                () => RunUpstreamAsync(factory, lifetime.Token),
                LazyThreadSafetyMode.ExecutionAndPublication),
            expiresAt,
            lifetime);
    }

    private async Task<TmdbMatch?> RunUpstreamAsync(
        Func<CancellationToken, Task<TmdbMatch?>> factory,
        CancellationToken lifetime)
    {
        var entered = false;
        try
        {
            await _upstreamGate.WaitAsync(lifetime);
            entered = true;
            return await factory(lifetime);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
            throw new SharedUpstreamTimeoutException();
        }
        finally
        {
            if (entered)
                _upstreamGate.Release();
        }
    }

    private async Task<TmdbMatch?> RunUncachedAsync(
        Func<CancellationToken, Task<TmdbMatch?>> factory,
        CancellationToken caller)
    {
        using var timeout = new CancellationTokenSource(_upstreamTimeout);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(caller, timeout.Token);
        var entered = false;
        try
        {
            await _upstreamGate.WaitAsync(lifetime.Token);
            entered = true;
            return await factory(lifetime.Token);
        }
        catch (OperationCanceledException) when (caller.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            if (entered)
                _upstreamGate.Release();
        }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var pair in _cache)
        {
            if (pair.Value.ExpiresAt <= now || pair.Value.Task.IsValueCreated &&
                (pair.Value.Task.Value.IsFaulted || pair.Value.Task.Value.IsCanceled))
            {
                Remove(pair.Key, pair.Value);
            }
        }
    }

    private void TrimToLimit()
    {
        while (_cache.Count > Math.Max(1, maxEntries))
        {
            var oldest = _cache.MinBy(p => p.Value.ExpiresAt);
            if (oldest.Key is null)
                break;
            if (!Remove(oldest.Key, oldest.Value))
                break;
        }
    }

    private bool Remove(string key, Entry entry)
    {
        if (!_cache.TryRemove(new KeyValuePair<string, Entry>(key, entry)))
            return false;
        entry.Retire();
        return true;
    }

    private sealed class Entry(
        Lazy<Task<TmdbMatch?>> task,
        DateTimeOffset expiresAt,
        CancellationTokenSource lifetime)
    {
        private int _retired;

        public Lazy<Task<TmdbMatch?>> Task { get; } = task;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;

        public void Retire()
        {
            if (Interlocked.Exchange(ref _retired, 1) != 0)
                return;

            lifetime.Cancel();
            // Force a canceled lazy task to materialize before disposing its token source. This
            // avoids a race where an already-observed entry starts after eviction and attempts to
            // register with a disposed source.
            _ = Task.Value.ContinueWith(
                static (completed, state) =>
                {
                    // Observe the private timeout exception so evicted entries cannot surface as
                    // unobserved task exceptions during finalization.
                    _ = completed.Exception;
                    ((CancellationTokenSource)state!).Dispose();
                },
                lifetime,
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    private sealed class SharedUpstreamTimeoutException : Exception;
}
