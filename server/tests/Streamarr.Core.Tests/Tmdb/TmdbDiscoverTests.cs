using System.Net;
using System.Text;
using Streamarr.Core.Media;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

/// <summary>Trending/popular lists, title logos and the separate list cache lifetime.</summary>
public class TmdbDiscoverTests
{
    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static TmdbClient Client(StubHttpMessageHandler handler, string? language = null)
        => new(new HttpClient(handler), new TmdbOptions { ApiKey = "test-key", Language = language }, retryDelay: static (_, _) => Task.CompletedTask);

    [Fact]
    public async Task TrendingAndPopular_UseTheWeeklyAndPopularRoutes_AndReadCardFields()
    {
        var handler = new StubHttpMessageHandler(req => req.RequestUri!.AbsolutePath switch
        {
            "/3/trending/movie/week" => Json("""
                {"results":[
                  {"id":10,"media_type":"movie","title":"Ten","original_title":"Zehn","release_date":"2020-01-02","vote_average":7.5,"poster_path":"/ten.jpg","backdrop_path":"/ten-bg.jpg","overview":"About ten."},
                  {"id":10,"media_type":"movie","title":"Ten again"},
                  {"id":0,"media_type":"movie","title":"Bad id"}
                ]}
                """),
            "/3/tv/popular" => Json("""{"results":[{"id":20,"name":"Twenty","original_name":"Zwanzig","first_air_date":"2019-05-01"}]}"""),
            _ => StubHttpMessageHandler.Status(HttpStatusCode.NotFound),
        });
        var client = Client(handler);

        var trending = await client.GetTrendingAsync(MediaType.Movie, default);
        var popular = await client.GetPopularAsync(MediaType.Tv, default);

        var ten = Assert.Single(trending);
        Assert.Equal((MediaType.Movie, 10, "Ten", "Zehn", 2020, 7.5F), (ten.MediaType, ten.TmdbId, ten.Title, ten.OriginalTitle, ten.Year, ten.CommunityRating));
        Assert.Equal("https://image.tmdb.org/t/p/w780/ten.jpg", ten.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/ten-bg.jpg", ten.BackdropUrl);
        Assert.Null(ten.OfficialRating);
        var twenty = Assert.Single(popular);
        Assert.Equal((MediaType.Tv, 20, "Twenty", "Zwanzig", 2019), (twenty.MediaType, twenty.TmdbId, twenty.Title, twenty.OriginalTitle, twenty.Year));
    }

    [Fact]
    public async Task Lists_WithoutCredential_AreEmptyWithoutHttp()
    {
        var handler = new StubHttpMessageHandler(_ => Json("""{"results":[]}"""));
        var client = new TmdbClient(new HttpClient(handler), new TmdbOptions());

        Assert.Empty(await client.GetTrendingAsync(MediaType.Tv, default));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Details_PickTheBestLogoInThePreferredLanguage_AsPng()
    {
        var handler = new StubHttpMessageHandler(req => req.RequestUri!.AbsolutePath == "/3/movie/5"
            ? Json("""
                {"id":5,"title":"Five","images":{"logos":[
                  {"file_path":"/textless.png","iso_639_1":null,"vote_average":9.9},
                  {"file_path":"/english-low.png","iso_639_1":"en","vote_average":1.0},
                  {"file_path":"/german.svg","iso_639_1":"de","vote_average":5.0},
                  {"file_path":"/german-worse.png","iso_639_1":"de","vote_average":2.0}
                ]}}
                """)
            : StubHttpMessageHandler.Status(HttpStatusCode.NotFound));

        var german = await Client(handler, "de-DE").GetMovieAsync(5, default);
        var english = await Client(handler).GetMovieAsync(5, default);

        Assert.Equal("https://image.tmdb.org/t/p/w500/german.png", german!.LogoUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w500/english-low.png", english!.LogoUrl);
        Assert.Contains("include_image_language=de,en,null", handler.Requests[0].Query, StringComparison.Ordinal);
        Assert.Contains("append_to_response=credits,release_dates,videos,images", handler.Requests[0].Query, StringComparison.Ordinal);
        Assert.Contains("include_image_language=en,null", handler.Requests[1].Query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Details_WithoutLogos_HaveNoLogoUrl()
    {
        var handler = new StubHttpMessageHandler(_ => Json("""{"id":7,"name":"Seven","images":{"logos":[]}}"""));

        var series = await Client(handler).GetTvAsync(7, default);

        Assert.Null(series!.LogoUrl);
        Assert.Contains("/3/tv/7", handler.Requests[0].AbsolutePath, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CachingClient_KeepsListsForTheShorterListLifetime()
    {
        var inner = new CountingLists();
        var time = new ManualTime();
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(24), time, listTtl: TimeSpan.FromHours(6));

        await caching.GetTrendingAsync(MediaType.Movie, default);
        await caching.GetTrendingAsync(MediaType.Movie, default);
        await caching.GetPopularAsync(MediaType.Movie, default);
        Assert.Equal((1, 1), (inner.Trending, inner.Popular));

        time.Advance(TimeSpan.FromHours(5));
        await caching.GetTrendingAsync(MediaType.Movie, default);
        Assert.Equal(1, inner.Trending);

        time.Advance(TimeSpan.FromHours(2));
        await caching.GetTrendingAsync(MediaType.Movie, default);
        await caching.GetTrendingAsync(MediaType.Tv, default);
        Assert.Equal(3, inner.Trending);
    }

    [Fact]
    public async Task DefaultInterfaceLists_AreEmpty()
    {
        ITmdbClient legacy = new CountingLegacy();

        Assert.Empty(await legacy.GetTrendingAsync(MediaType.Movie, default));
        Assert.Empty(await legacy.GetPopularAsync(MediaType.Tv, default));
    }

    private sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UnixEpoch;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private class CountingLegacy : ITmdbClient
    {
        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
    }

    private sealed class CountingLists : CountingLegacy, ITmdbClient
    {
        public int Trending;
        public int Popular;

        public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
        {
            Trending++;
            return Task.FromResult<IReadOnlyList<TmdbMatch>>([new TmdbMatch { MediaType = mediaType, TmdbId = 1, Title = "One" }]);
        }

        public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
        {
            Popular++;
            return Task.FromResult<IReadOnlyList<TmdbMatch>>([]);
        }
    }
}
