using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public class CachingTmdbClientTests
{
    private sealed class CountingTmdbClient : ITmdbClient
    {
        public int AnySearches;
        public int CandidateSearches;
        public int MovieSearches;
        public int SeriesCatalogSearches;
        public int SeasonCatalogSearches;
        public int TransientMovieFailures;
        public TmdbMatch? Result;
        public TmdbTvSeriesCatalog? SeriesCatalogResult;
        public TmdbTvSeasonCatalog? SeasonCatalogResult;

        public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(
            string query,
            MediaType? mediaType,
            CancellationToken cancellationToken)
        {
            CandidateSearches++;
            IReadOnlyList<TmdbMatch> matches = Result is null ? [] : [Result];
            return Task.FromResult(matches);
        }

        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        {
            AnySearches++;
            return Task.FromResult(Result);
        }

        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        {
            MovieSearches++;
            if (TransientMovieFailures > 0)
            {
                TransientMovieFailures--;
                return Task.FromException<TmdbMatch?>(
                    new TmdbTransientException("temporary TMDB failure"));
            }
            return Task.FromResult(Result);
        }

        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        {
            SeriesCatalogSearches++;
            return Task.FromResult(SeriesCatalogResult);
        }

        public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(
            int tmdbId,
            int seasonNumber,
            CancellationToken cancellationToken)
        {
            SeasonCatalogSearches++;
            return Task.FromResult(SeasonCatalogResult);
        }

        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    }

    private sealed class BlockingTmdbClient : ITmdbClient
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _current;
        private int _started;

        public int MaxConcurrent { get; private set; }
        public int Started => Volatile.Read(ref _started);

        public void Release() => _release.TrySetResult();

        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
            => SearchMovieAsync(query, null, cancellationToken);

        public async Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _started);
            var current = Interlocked.Increment(ref _current);
            MaxConcurrent = Math.Max(MaxConcurrent, current);
            try
            {
                await _release.Task.WaitAsync(cancellationToken);
                return Sample;
            }
            finally
            {
                Interlocked.Decrement(ref _current);
            }
        }

        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => SearchMovieAsync(title, null, cancellationToken);
        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => SearchMovieAsync(tmdbId.ToString(), null, cancellationToken);
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => SearchMovieAsync(tmdbId.ToString(), null, cancellationToken);
        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => SearchMovieAsync(imdbId, null, cancellationToken);
    }

    private sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private static readonly TmdbMatch Sample = new()
    {
        MediaType = MediaType.Movie,
        TmdbId = 1,
        Title = "Example",
    };

    [Fact]
    public async Task CachesHitsForTheSameQuery()
    {
        var inner = new CountingTmdbClient { Result = Sample };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        var first = await caching.SearchMovieAsync("Example", 2021, default);
        var second = await caching.SearchMovieAsync("Example", 2021, default);

        Assert.Same(first, second);
        Assert.Equal(1, inner.MovieSearches);
    }

    [Fact]
    public async Task CachesUnconstrainedSemanticSearches()
    {
        var inner = new CountingTmdbClient { Result = Sample };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        Assert.Same(Sample, await caching.SearchAnyAsync("Dune 2", default));
        Assert.Same(Sample, await caching.SearchAnyAsync("Dune 2", default));
        Assert.Equal(1, inner.AnySearches);
    }

    [Fact]
    public async Task CachesOrderedDiscoveryCandidates()
    {
        var inner = new CountingTmdbClient { Result = Sample };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        var first = await caching.SearchCandidatesAsync("Dune 2", null, default);
        var second = await caching.SearchCandidatesAsync("Dune 2", null, default);

        Assert.Same(first, second);
        Assert.Same(Sample, Assert.Single(first));
        Assert.Equal(1, inner.CandidateSearches);
    }

    [Fact]
    public async Task CachesSeriesAndSeasonDirectoriesIndependently()
    {
        var series = new TmdbTvSeriesCatalog { Series = Sample, Seasons = [] };
        var season = new TmdbTvSeasonCatalog
        {
            TmdbId = 1,
            SeasonNumber = 2,
            Title = "Season 2",
            Episodes = [],
        };
        var inner = new CountingTmdbClient
        {
            SeriesCatalogResult = series,
            SeasonCatalogResult = season,
        };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        Assert.Same(series, await caching.GetTvSeriesCatalogAsync(1, default));
        Assert.Same(series, await caching.GetTvSeriesCatalogAsync(1, default));
        Assert.Same(season, await caching.GetTvSeasonCatalogAsync(1, 2, default));
        Assert.Same(season, await caching.GetTvSeasonCatalogAsync(1, 2, default));

        Assert.Equal(1, inner.SeriesCatalogSearches);
        Assert.Equal(1, inner.SeasonCatalogSearches);
    }

    [Fact]
    public async Task CachesMissesToo()
    {
        var inner = new CountingTmdbClient { Result = null };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        Assert.Null(await caching.SearchMovieAsync("Nope", null, default));
        Assert.Null(await caching.SearchMovieAsync("Nope", null, default));

        Assert.Equal(1, inner.MovieSearches);
    }

    [Fact]
    public async Task TransientFailure_IsNotCachedAndIdenticalCallRetriesImmediately()
    {
        var inner = new CountingTmdbClient
        {
            Result = Sample,
            TransientMovieFailures = 1,
        };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(24));

        Assert.Null(await caching.SearchMovieAsync("Example", null, default));
        Assert.Same(Sample, await caching.SearchMovieAsync("Example", null, default));
        Assert.Equal(2, inner.MovieSearches);
    }

    [Fact]
    public async Task CredentialRevision_BypassesMissCachedByPreviousCredential()
    {
        var revision = 0L;
        var inner = new CountingTmdbClient { Result = null };
        var caching = new CachingTmdbClient(
            inner,
            TimeSpan.FromHours(1),
            credentialRevision: () => revision);

        Assert.Null(await caching.SearchMovieAsync("Dune 2", null, default));
        inner.Result = Sample;
        revision++;

        Assert.Same(Sample, await caching.SearchMovieAsync("Dune 2", null, default));
        Assert.Equal(2, inner.MovieSearches);
    }

    [Fact]
    public async Task DistinctQueriesAreCachedSeparately()
    {
        var inner = new CountingTmdbClient { Result = Sample };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        await caching.SearchMovieAsync("Example", 2021, default);
        await caching.SearchMovieAsync("Example", 2020, default);

        Assert.Equal(2, inner.MovieSearches);
    }

    [Fact]
    public async Task RefetchesAfterTtlExpiry()
    {
        var time = new ManualTimeProvider(DateTimeOffset.UnixEpoch);
        var inner = new CountingTmdbClient { Result = Sample };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1), time);

        await caching.SearchMovieAsync("Example", 2021, default);
        time.Advance(TimeSpan.FromHours(2));
        await caching.SearchMovieAsync("Example", 2021, default);

        Assert.Equal(2, inner.MovieSearches);
    }

    [Fact]
    public async Task BoundsConcurrentSharedUpstreamCalls()
    {
        var inner = new BlockingTmdbClient();
        var caching = new CachingTmdbClient(
            inner,
            TimeSpan.FromHours(1),
            maxConcurrentUpstream: 2,
            upstreamTimeout: TimeSpan.FromSeconds(5));

        var calls = new[]
        {
            caching.SearchMovieAsync("One", null, default),
            caching.SearchMovieAsync("Two", null, default),
            caching.SearchMovieAsync("Three", null, default),
        };
        await WaitUntilAsync(() => inner.Started == 2);
        Assert.Equal(2, inner.MaxConcurrent);
        Assert.Equal(2, inner.Started);

        inner.Release();
        await Task.WhenAll(calls);
        Assert.Equal(2, inner.MaxConcurrent);
        Assert.Equal(3, inner.Started);
    }

    [Fact]
    public async Task HardTimeoutEndsOrphanedSharedWorkAndDoesNotCacheTheTimeout()
    {
        var inner = new BlockingTmdbClient();
        var caching = new CachingTmdbClient(
            inner,
            TimeSpan.FromHours(1),
            upstreamTimeout: TimeSpan.FromMilliseconds(100));

        Assert.Null(await caching.SearchMovieAsync("Stuck", null, default));
        Assert.Null(await caching.SearchMovieAsync("Stuck", null, default));
        Assert.Equal(2, inner.Started);
    }

    [Fact]
    public async Task NoCacheModeStillAppliesTheGlobalUpstreamLimitAndTimeout()
    {
        var inner = new BlockingTmdbClient();
        var caching = new CachingTmdbClient(
            inner,
            TimeSpan.Zero,
            maxConcurrentUpstream: 1,
            upstreamTimeout: TimeSpan.FromMilliseconds(100));

        var calls = new[]
        {
            caching.SearchMovieAsync("One", null, default),
            caching.SearchMovieAsync("Two", null, default),
        };

        Assert.All(await Task.WhenAll(calls), Assert.Null);
        Assert.Equal(1, inner.MaxConcurrent);
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }
}
