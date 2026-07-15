using System.Collections.Concurrent;
using Streamarr.Core.Media;

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
    TimeSpan? upstreamTimeout = null,
    Func<long>? credentialRevision = null) : ITmdbClient
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, IEntry> _cache = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _upstreamGate = new(Math.Max(1, maxConcurrentUpstream));
    private readonly TimeSpan _upstreamTimeout = upstreamTimeout is { } configured && configured > TimeSpan.Zero
        ? configured
        : TimeSpan.FromSeconds(20);

    public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(
        string query,
        MediaType? mediaType,
        CancellationToken cancellationToken)
        => GetOrAddAsync(
            $"search-candidates|{mediaType?.ToString().ToLowerInvariant() ?? "any"}|{query.ToLowerInvariant()}",
            ct => inner.SearchCandidatesAsync(query, mediaType, ct),
            Array.Empty<TmdbMatch>(),
            cancellationToken);

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-any|{query.ToLowerInvariant()}", ct => inner.SearchAnyAsync(query, ct), null, cancellationToken);

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-movie|{title.ToLowerInvariant()}|{year}", ct => inner.SearchMovieAsync(title, year, ct), null, cancellationToken);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => GetOrAddAsync($"search-tv|{title.ToLowerInvariant()}", ct => inner.SearchTvAsync(title, ct), null, cancellationToken);

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"movie|{tmdbId}", ct => inner.GetMovieAsync(tmdbId, ct), null, cancellationToken);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"tv|{tmdbId}", ct => inner.GetTvAsync(tmdbId, ct), null, cancellationToken);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        => GetOrAddAsync(
            $"tv-catalog|{tmdbId}",
            ct => inner.GetTvSeriesCatalogAsync(tmdbId, ct),
            null,
            cancellationToken);

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(
        int tmdbId,
        int seasonNumber,
        CancellationToken cancellationToken)
        => GetOrAddAsync(
            $"tv-season|{tmdbId}|{seasonNumber}",
            ct => inner.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, ct),
            null,
            cancellationToken);

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => GetOrAddAsync($"imdb|{imdbId.ToLowerInvariant()}", ct => inner.FindByImdbAsync(imdbId, ct), null, cancellationToken);

    private Task<T> GetOrAddAsync<T>(
        string key,
        Func<CancellationToken, Task<T>> factory,
        T timeoutFallback,
        CancellationToken cancellationToken)
    {
        // Credential replacements must not reuse a cached miss (or result) produced with
        // the prior credential. The revision contains no secret material.
        key = $"{credentialRevision?.Invoke() ?? 0}|{key}";

        if (ttl <= TimeSpan.Zero)
            return RunUncachedAsync(factory, timeoutFallback, cancellationToken);

        while (true)
        {
            var now = _time.GetUtcNow();
            if (_cache.TryGetValue(key, out var untyped))
            {
                if (untyped is not Entry<T> existing)
                {
                    Remove(key, untyped);
                    continue;
                }
                if (existing.ExpiresAt > now)
                    return Await(existing, key, timeoutFallback, cancellationToken);
                Remove(key, existing);
            }

            Prune(now);
            var created = CreateEntry(factory, now + ttl);
            var actual = _cache.GetOrAdd(key, created);
            if (!ReferenceEquals(actual, created))
                created.Retire();
            TrimToLimit();
            if (actual.ExpiresAt > now)
                return Await((Entry<T>)actual, key, timeoutFallback, cancellationToken);
        }
    }

    private async Task<T> Await<T>(Entry<T> entry, string key, T timeoutFallback, CancellationToken ct)
    {
        Task<T> task;
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
        catch (TmdbTransientException)
        {
            Remove(key, entry);
            return timeoutFallback;
        }
        catch (SharedUpstreamTimeoutException)
        {
            Remove(key, entry);
            return timeoutFallback;
        }
        catch when (task.IsFaulted || task.IsCanceled)
        {
            Remove(key, entry);
            throw;
        }
    }

    private Entry<T> CreateEntry<T>(Func<CancellationToken, Task<T>> factory, DateTimeOffset expiresAt)
    {
        var lifetime = new CancellationTokenSource(_upstreamTimeout);
        return new Entry<T>(
            new Lazy<Task<T>>(
                () => RunUpstreamAsync(factory, lifetime.Token),
                LazyThreadSafetyMode.ExecutionAndPublication),
            expiresAt,
            lifetime);
    }

    private async Task<T> RunUpstreamAsync<T>(
        Func<CancellationToken, Task<T>> factory,
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

    private async Task<T> RunUncachedAsync<T>(
        Func<CancellationToken, Task<T>> factory,
        T timeoutFallback,
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
            return timeoutFallback;
        }
        catch (TmdbTransientException)
        {
            return timeoutFallback;
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
            if (pair.Value.ExpiresAt <= now || pair.Value.IsFaultedOrCanceled)
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

    private bool Remove(string key, IEntry entry)
    {
        if (!_cache.TryRemove(new KeyValuePair<string, IEntry>(key, entry)))
            return false;
        entry.Retire();
        return true;
    }

    private interface IEntry
    {
        DateTimeOffset ExpiresAt { get; }
        bool IsFaultedOrCanceled { get; }
        void Retire();
    }

    private sealed class Entry<T>(
        Lazy<Task<T>> task,
        DateTimeOffset expiresAt,
        CancellationTokenSource lifetime) : IEntry
    {
        private int _retired;

        public Lazy<Task<T>> Task { get; } = task;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public bool IsFaultedOrCanceled => Task.IsValueCreated && (Task.Value.IsFaulted || Task.Value.IsCanceled);

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
