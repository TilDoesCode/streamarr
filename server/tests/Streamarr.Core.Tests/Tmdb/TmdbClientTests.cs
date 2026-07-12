using System.Net;
using System.Text;
using Streamarr.Core.Media;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public class TmdbClientTests
{
    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static TmdbClient Client(StubHttpMessageHandler handler, string apiKey = "test-key")
        => new(new HttpClient(handler), new TmdbOptions { ApiKey = apiKey });

    [Fact]
    public async Task SearchMovie_ResolvesIdThenEnrichesFromDetail()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.EndsWith("/search/movie", StringComparison.Ordinal))
                return Json("""{"results":[{"id":12345,"title":"Example Movie"}]}""");
            if (path.EndsWith("/movie/12345", StringComparison.Ordinal))
                return Json("""
                    {"id":12345,"title":"Example Movie","release_date":"2021-05-01",
                     "overview":"An example.","poster_path":"/poster.jpg","backdrop_path":"/back.jpg",
                     "runtime":130,"imdb_id":"tt1234567"}
                    """);
            return StubHttpMessageHandler.Status(HttpStatusCode.NotFound);
        });

        var match = await Client(handler).SearchMovieAsync("Example Movie", 2021, default);

        Assert.NotNull(match);
        Assert.Equal(MediaType.Movie, match!.MediaType);
        Assert.Equal(12345, match.TmdbId);
        Assert.Equal("Example Movie", match.Title);
        Assert.Equal(2021, match.Year);
        Assert.Equal(130, match.RuntimeMinutes);
        Assert.Equal("tt1234567", match.ImdbId);
        Assert.Equal("https://image.tmdb.org/t/p/w500/poster.jpg", match.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/back.jpg", match.BackdropUrl);
    }

    [Fact]
    public async Task SearchTv_ReadsEpisodeRuntimeAndExternalImdbId()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.EndsWith("/search/tv", StringComparison.Ordinal))
                return Json("""{"results":[{"id":456,"name":"Example Show"}]}""");
            if (path.EndsWith("/tv/456", StringComparison.Ordinal))
                return Json("""
                    {"id":456,"name":"Example Show","first_air_date":"2019-01-01",
                     "episode_run_time":[42],"poster_path":"/p.jpg",
                     "external_ids":{"imdb_id":"tt9999999"}}
                    """);
            return StubHttpMessageHandler.Status(HttpStatusCode.NotFound);
        });

        var match = await Client(handler).SearchTvAsync("Example Show", default);

        Assert.NotNull(match);
        Assert.Equal(MediaType.Tv, match!.MediaType);
        Assert.Equal(456, match.TmdbId);
        Assert.Equal("Example Show", match.Title);
        Assert.Equal(2019, match.Year);
        Assert.Equal(42, match.RuntimeMinutes);
        Assert.Equal("tt9999999", match.ImdbId);
    }

    [Fact]
    public async Task FindByImdb_MapsMovieResult()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.Contains("/find/", StringComparison.Ordinal))
                return Json("""{"movie_results":[{"id":12345}],"tv_results":[]}""");
            if (path.EndsWith("/movie/12345", StringComparison.Ordinal))
                return Json("""{"id":12345,"title":"Example Movie","runtime":120}""");
            return StubHttpMessageHandler.Status(HttpStatusCode.NotFound);
        });

        var match = await Client(handler).FindByImdbAsync("tt1234567", default);

        Assert.NotNull(match);
        Assert.Equal(12345, match!.TmdbId);
        Assert.Equal(MediaType.Movie, match.MediaType);
    }

    [Fact]
    public async Task SearchMovie_ReturnsNullOnEmptyResults()
    {
        var handler = new StubHttpMessageHandler(_ => Json("""{"results":[]}"""));
        Assert.Null(await Client(handler).SearchMovieAsync("Nothing", null, default));
    }

    [Fact]
    public async Task NoApiKey_ShortCircuitsWithoutHttpCall()
    {
        var handler = new StubHttpMessageHandler(_ => throw new InvalidOperationException("should not be called"));
        var client = Client(handler, apiKey: "");

        Assert.Null(await client.SearchMovieAsync("Example", 2021, default));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task PassesApiKeyOnEveryRequest()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.EndsWith("/search/movie", StringComparison.Ordinal))
                return Json("""{"results":[{"id":1}]}""");
            return Json("""{"id":1,"title":"X","runtime":90}""");
        });

        await Client(handler, apiKey: "secret-key").SearchMovieAsync("X", null, default);

        Assert.All(handler.Requests, uri => Assert.Contains("api_key=secret-key", uri.Query));
    }
}
