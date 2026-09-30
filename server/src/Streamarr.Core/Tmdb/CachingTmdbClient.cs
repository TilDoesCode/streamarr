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
    Func<long>? credentialRevision = null,
    TimeSpan? listTtl = null) : ITmdbClient
{
    private readonly TimeSpan _listTtl = listTtl is { } configuredList && configuredList < ttl ? configuredList : ttl;
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, IEntry> _cache = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _upstreamGate = new(Math.Max(1, maxConcurrentUpstream));
    private readonly TimeSpan _upstreamTimeout = upstreamTimeout is { } configured && configured > TimeSpan.Zero
        ? configured
        : TimeSpan.FromSeconds(20);

    private StrictView? _strict;

    /// <summary>The same cache and single-flight calls, but a transient failure throws <see cref="TmdbTransientException"/> instead of returning the miss fallback.</summary>
    public ITmdbClient Strict => _strict ??= new StrictView(this);

    public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(string query, MediaType? mediaType, CancellationToken cancellationToken)
        => Candidates(query, mediaType, false, cancellationToken);

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => Any(query, false, cancellationToken);

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => MovieSearch(title, year, false, cancellationToken);

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => TvSearch(title, false, cancellationToken);

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Movie(tmdbId, false, cancellationToken);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Tv(tmdbId, false, cancellationToken);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        => SeriesCatalog(tmdbId, false, cancellationToken);

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
        => SeasonCatalog(tmdbId, seasonNumber, false, cancellationToken);

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
        => Imdb(imdbId, false, cancellationToken);

    public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Trending(mediaType, false, cancellationToken);

    public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Popular(mediaType, false, cancellationToken);

    public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
        => Discover(query, false, cancellationToken);

    public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Genres(mediaType, false, cancellationToken);

    private Task<IReadOnlyList<TmdbMatch>> Candidates(string query, MediaType? mediaType, bool strict, CancellationToken ct)
        => GetOrAddAsync(
            $"search-candidates|{mediaType?.ToString().ToLowerInvariant() ?? "any"}|{query.ToLowerInvariant()}",
            c => inner.SearchCandidatesAsync(query, mediaType, c),
            Array.Empty<TmdbMatch>(),
            strict,
            ct);

    private Task<TmdbMatch?> Any(string query, bool strict, CancellationToken ct)
        => GetOrAddAsync($"search-any|{query.ToLowerInvariant()}", c => inner.SearchAnyAsync(query, c), null, strict, ct);

    private Task<TmdbMatch?> MovieSearch(string title, int? year, bool strict, CancellationToken ct)
        => GetOrAddAsync($"search-movie|{title.ToLowerInvariant()}|{year}", c => inner.SearchMovieAsync(title, year, c), null, strict, ct);

    private Task<TmdbMatch?> TvSearch(string title, bool strict, CancellationToken ct)
        => GetOrAddAsync($"search-tv|{title.ToLowerInvariant()}", c => inner.SearchTvAsync(title, c), null, strict, ct);

    private Task<TmdbMatch?> Movie(int tmdbId, bool strict, CancellationToken ct)
        => GetOrAddAsync($"movie|{tmdbId}", c => inner.GetMovieAsync(tmdbId, c), null, strict, ct);

    private Task<TmdbMatch?> Tv(int tmdbId, bool strict, CancellationToken ct)
        => GetOrAddAsync($"tv|{tmdbId}", c => inner.GetTvAsync(tmdbId, c), null, strict, ct);

    private Task<TmdbTvSeriesCatalog?> SeriesCatalog(int tmdbId, bool strict, CancellationToken ct)
        => GetOrAddAsync($"tv-catalog|{tmdbId}", c => inner.GetTvSeriesCatalogAsync(tmdbId, c), null, strict, ct);

    private Task<TmdbTvSeasonCatalog?> SeasonCatalog(int tmdbId, int seasonNumber, bool strict, CancellationToken ct)
        => GetOrAddAsync($"tv-season|{tmdbId}|{seasonNumber}", c => inner.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, c), null, strict, ct);

    private Task<TmdbMatch?> Imdb(string imdbId, bool strict, CancellationToken ct)
        => GetOrAddAsync($"imdb|{imdbId.ToLowerInvariant()}", c => inner.FindByImdbAsync(imdbId, c), null, strict, ct);

    private Task<IReadOnlyList<TmdbMatch>> Trending(MediaType mediaType, bool strict, CancellationToken ct)
        => GetOrAddAsync(
            $"trending|{mediaType.ToString().ToLowerInvariant()}",
            c => inner.GetTrendingAsync(mediaType, c),
            Array.Empty<TmdbMatch>(),
            strict,
            ct,
            _listTtl);

    private Task<IReadOnlyList<TmdbMatch>> Popular(MediaType mediaType, bool strict, CancellationToken ct)
        => GetOrAddAsync(
            $"popular|{mediaType.ToString().ToLowerInvariant()}",
            c => inner.GetPopularAsync(mediaType, c),
            Array.Empty<TmdbMatch>(),
            strict,
            ct,
            _listTtl);

    private Task<TmdbDiscoverPage> Discover(TmdbDiscoverQuery query, bool strict, CancellationToken ct)
        => GetOrAddAsync(
            $"discover|{query.MediaType.ToString().ToLowerInvariant()}|{query.GenreId}|{query.Sort.ToString().ToLowerInvariant()}|{query.Page}",
            c => inner.DiscoverAsync(query, c),
            TmdbDiscoverPage.Empty,
            strict,
            ct,
            _listTtl);

    private Task<IReadOnlyList<TmdbGenre>> Genres(MediaType mediaType, bool strict, CancellationToken ct)
        => GetOrAddAsync(
            $"genres|{mediaType.ToString().ToLowerInvariant()}",
            c => inner.GetGenresAsync(mediaType, c),
            Array.Empty<TmdbGenre>(),
            strict,
            ct);

    private Task<T> GetOrAddAsync<T>(
        string key,
        Func<CancellationToken, Task<T>> factory,
        T timeoutFallback,
        bool strict,
        CancellationToken cancellationToken,
        TimeSpan? lifetime = null)
    {
        // Credential replacements must not reuse a cached miss (or result) produced with
        // the prior credential. The revision contains no secret material.
        key = $"{credentialRevision?.Invoke() ?? 0}|{key}";
        var entryTtl = lifetime ?? ttl;

        if (entryTtl <= TimeSpan.Zero)
            return RunUncachedAsync(factory, timeoutFallback, strict, cancellationToken);

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
                    return Await(existing, key, timeoutFallback, strict, cancellationToken);
                Remove(key, existing);
            }

            Prune(now);
            var created = CreateEntry(factory, now + entryTtl);
            var actual = _cache.GetOrAdd(key, created);
            if (!ReferenceEquals(actual, created))
                created.Retire();
            TrimToLimit();
            if (actual.ExpiresAt > now)
                return Await((Entry<T>)actual, key, timeoutFallback, strict, cancellationToken);
        }
    }

    private async Task<T> Await<T>(Entry<T> entry, string key, T timeoutFallback, bool strict, CancellationToken ct)
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
        catch (TmdbTransientException) when (!strict)
        {
            Remove(key, entry);
            return timeoutFallback;
        }
        catch (TmdbTransientException)
        {
            Remove(key, entry);
            throw;
        }
        catch (SharedUpstreamTimeoutException)
        {
            Remove(key, entry);
            return strict ? throw TimedOut() : timeoutFallback;
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
        bool strict,
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
            return strict ? throw TimedOut() : timeoutFallback;
        }
        catch (TmdbTransientException) when (!strict)
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

    private static TmdbTransientException TimedOut() => new("TMDB did not answer in time.");

    private sealed class SharedUpstreamTimeoutException : Exception;

    private sealed class StrictView(CachingTmdbClient owner) : ITmdbClient
    {
        public ITmdbClient Strict => this;

        public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(string query, MediaType? mediaType, CancellationToken cancellationToken)
            => owner.Candidates(query, mediaType, true, cancellationToken);

        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => owner.Any(query, true, cancellationToken);

        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
            => owner.MovieSearch(title, year, true, cancellationToken);

        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => owner.TvSearch(title, true, cancellationToken);

        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => owner.Movie(tmdbId, true, cancellationToken);

        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => owner.Tv(tmdbId, true, cancellationToken);

        public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
            => owner.SeriesCatalog(tmdbId, true, cancellationToken);

        public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
            => owner.SeasonCatalog(tmdbId, seasonNumber, true, cancellationToken);

        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => owner.Imdb(imdbId, true, cancellationToken);

        public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
            => owner.Trending(mediaType, true, cancellationToken);

        public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
            => owner.Popular(mediaType, true, cancellationToken);

        public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
            => owner.Discover(query, true, cancellationToken);

        public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
            => owner.Genres(mediaType, true, cancellationToken);
    }
}
