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
    public async Task Details_PickPostersAndBackdropsInTheViewersLanguage_TextlessBeforeEnglish()
    {
        var handler = new StubHttpMessageHandler(req => req.RequestUri!.AbsolutePath switch
        {
            "/3/movie/6" => Json("""
                {"id":6,"title":"Six","overview":"o","tagline":"t","poster_path":"/en.jpg","backdrop_path":"/bg-en.jpg","images":{
                  "posters":[
                    {"file_path":"/en.jpg","iso_639_1":"en","vote_average":5.0},
                    {"file_path":"/textless.jpg","iso_639_1":null,"vote_average":6.0},
                    {"file_path":"/de-worse.jpg","iso_639_1":"de","vote_average":2.0},
                    {"file_path":"/de.jpg","iso_639_1":"de","vote_average":4.0}],
                  "backdrops":[
                    {"file_path":"/bg-en.jpg","iso_639_1":"en","vote_average":7.0},
                    {"file_path":"/bg-de.jpg","iso_639_1":"de","vote_average":8.0},
                    {"file_path":"/bg-textless.jpg","iso_639_1":null,"vote_average":3.0}]}}
                """),
            "/3/movie/8" => Json("""
                {"id":8,"title":"Eight","overview":"o","tagline":"t","poster_path":"/en8.jpg","backdrop_path":"/bg8.jpg","images":{
                  "posters":[
                    {"file_path":"/en8.jpg","iso_639_1":"en","vote_average":9.0},
                    {"file_path":"/textless8.jpg","iso_639_1":null,"vote_average":1.0}],
                  "backdrops":[]}}
                """),
            _ => StubHttpMessageHandler.Status(HttpStatusCode.NotFound),
        });
        var client = Client(handler);

        var english = await client.GetMovieAsync(6, default);
        var englishOnly = await client.GetMovieAsync(8, default);
        TmdbMatch? german, textless;
        using (TmdbLanguage.Use("de"))
        {
            german = await client.GetMovieAsync(6, default);
            textless = await client.GetMovieAsync(8, default);
        }

        Assert.Equal(("https://image.tmdb.org/t/p/w780/de.jpg", "https://image.tmdb.org/t/p/w1280/bg-textless.jpg"), (german!.PosterUrl, german.BackdropUrl));
        Assert.Equal(("https://image.tmdb.org/t/p/w780/en.jpg", "https://image.tmdb.org/t/p/w1280/bg-textless.jpg"), (english!.PosterUrl, english.BackdropUrl));
        Assert.Equal("https://image.tmdb.org/t/p/w780/textless8.jpg", textless!.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w780/en8.jpg", englishOnly!.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/bg8.jpg", textless.BackdropUrl);
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

    [Theory]
    [InlineData(MediaType.Movie, null, TmdbDiscoverSort.Popular, 1, "discover/movie?include_adult=false&include_video=false&page=1&sort_by=popularity.desc")]
    [InlineData(MediaType.Movie, 16, TmdbDiscoverSort.TopRated, 2,
        "discover/movie?include_adult=false&include_video=false&page=2&sort_by=vote_average.desc&vote_count.gte=300&with_genres=16")]
    [InlineData(MediaType.Tv, 18, TmdbDiscoverSort.Newest, 3,
        "discover/tv?include_adult=false&include_video=false&page=3&sort_by=first_air_date.desc&first_air_date.lte=2026-09-30&vote_count.gte=10&with_genres=18")]
    [InlineData(MediaType.Movie, null, TmdbDiscoverSort.Newest, 1,
        "discover/movie?include_adult=false&include_video=false&page=1&sort_by=primary_release_date.desc&primary_release_date.lte=2026-09-30&vote_count.gte=10")]
    public void DiscoverRoute_MapsGenreSortAndPage(MediaType type, int? genre, TmdbDiscoverSort sort, int page, string expected)
        => Assert.Equal(expected, TmdbClient.DiscoverRoute(new TmdbDiscoverQuery(type, genre, sort, page), new DateOnly(2026, 9, 30)));

    [Fact]
    public async Task Discover_ReadsCardsAndPaging_AndGenres_ReadIdsAndNames()
    {
        var handler = new StubHttpMessageHandler(req => req.RequestUri!.AbsolutePath switch
        {
            "/3/discover/tv" => Json("""{"page":2,"total_pages":900,"total_results":17990,"results":[{"id":20,"name":"Twenty","first_air_date":"2019-05-01"}]}"""),
            "/3/genre/movie/list" => Json("""{"genres":[{"id":28,"name":"Action"},{"id":0,"name":"Bad"},{"id":16,"name":""},{"id":35,"name":"Komödie"}]}"""),
            _ => StubHttpMessageHandler.Status(HttpStatusCode.NotFound),
        });
        var client = Client(handler, "de-DE");

        var page = await client.DiscoverAsync(new TmdbDiscoverQuery(MediaType.Tv, 10765, TmdbDiscoverSort.Popular, 2), default);
        var genres = await client.GetGenresAsync(MediaType.Movie, default);

        var twenty = Assert.Single(page.Items);
        Assert.Equal((MediaType.Tv, 20, "Twenty", 2019), (twenty.MediaType, twenty.TmdbId, twenty.Title, twenty.Year));
        Assert.Equal((2, TmdbDiscoverQuery.MaxPage, 17990), (page.Page, page.TotalPages, page.TotalResults));
        Assert.Contains("with_genres=10765", handler.Requests[0].Query, StringComparison.Ordinal);
        Assert.Contains("language=de-DE", handler.Requests[1].Query, StringComparison.Ordinal);
        Assert.Equal([new TmdbGenre(28, "Action"), new TmdbGenre(35, "Komödie")], genres);
    }

    [Fact]
    public async Task CachingClient_KeepsDiscoverPagesPerQuery_AndGenresForTheFullLifetime()
    {
        var inner = new CountingLists();
        var time = new ManualTime();
        var caching = new CachingTmdbClient(inner, TimeSpan.FromHours(24), time, listTtl: TimeSpan.FromHours(6));
        var query = new TmdbDiscoverQuery(MediaType.Movie, 16, TmdbDiscoverSort.TopRated, 2);

        await caching.DiscoverAsync(query, default);
        await caching.DiscoverAsync(query with { }, default);
        await caching.DiscoverAsync(query with { Page = 3 }, default);
        await caching.DiscoverAsync(query with { GenreId = null }, default);
        await caching.DiscoverAsync(query with { Sort = TmdbDiscoverSort.Newest }, default);
        await caching.DiscoverAsync(query with { MediaType = MediaType.Tv }, default);
        await caching.GetGenresAsync(MediaType.Movie, default);
        await caching.GetGenresAsync(MediaType.Movie, default);
        Assert.Equal((5, 1), (inner.Discover, inner.Genres));

        time.Advance(TimeSpan.FromHours(7));
        await caching.DiscoverAsync(query, default);
        await caching.GetGenresAsync(MediaType.Movie, default);
        Assert.Equal((6, 1), (inner.Discover, inner.Genres));
    }

    [Fact]
    public async Task DefaultInterfaceLists_AreEmpty()
    {
        ITmdbClient legacy = new CountingLegacy();

        Assert.Empty(await legacy.GetTrendingAsync(MediaType.Movie, default));
        Assert.Empty(await legacy.GetPopularAsync(MediaType.Tv, default));
        Assert.Empty((await legacy.DiscoverAsync(new TmdbDiscoverQuery(MediaType.Movie, null, TmdbDiscoverSort.Popular, 1), default)).Items);
        Assert.Empty(await legacy.GetGenresAsync(MediaType.Tv, default));
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
        public int Discover;
        public int Genres;

        public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
        {
            Discover++;
            return Task.FromResult(new TmdbDiscoverPage([], query.Page, 1, 0));
        }

        public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
        {
            Genres++;
            return Task.FromResult<IReadOnlyList<TmdbGenre>>([new TmdbGenre(1, "One")]);
        }
    }
}
