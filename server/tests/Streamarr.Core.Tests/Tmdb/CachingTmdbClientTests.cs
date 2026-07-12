using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public class CachingTmdbClientTests
{
    private sealed class CountingTmdbClient : ITmdbClient
    {
        public int MovieSearches;
        public TmdbMatch? Result;

        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        {
            MovieSearches++;
            return Task.FromResult(Result);
        }

        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
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
    public async Task CachesMissesToo()
    {
        var inner = new CountingTmdbClient { Result = null };
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(1));

        Assert.Null(await caching.SearchMovieAsync("Nope", null, default));
        Assert.Null(await caching.SearchMovieAsync("Nope", null, default));

        Assert.Equal(1, inner.MovieSearches);
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
}
