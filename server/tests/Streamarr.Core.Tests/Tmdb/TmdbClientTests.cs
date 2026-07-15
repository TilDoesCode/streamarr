using System.Net;
using System.Text;
using Streamarr.Core.Media;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public class TmdbClientTests
{
    private sealed class UnknownLengthContent(byte[] body) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => stream.WriteAsync(body).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    private static HttpResponseMessage Json(string body)
        => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static TmdbClient Client(StubHttpMessageHandler handler, string apiKey = "test-key")
        => new(new HttpClient(handler), new TmdbOptions { ApiKey = apiKey });

    [Fact]
    public async Task SearchAny_UsesMultiSearchOrderingAndSkipsPeople()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.EndsWith("/search/multi", StringComparison.Ordinal))
            {
                return Json("""
                    {"results":[
                      {"id":99,"media_type":"person","name":"Someone"},
                      {"id":693134,"media_type":"movie","title":"Dune: Part Two"}
                    ]}
                    """);
            }

            if (path.EndsWith("/movie/693134", StringComparison.Ordinal))
            {
                return Json("""
                    {"id":693134,"title":"Dune: Part Two","release_date":"2024-02-27",
                     "runtime":167,"poster_path":"/dune.jpg","backdrop_path":"/dune-bg.jpg",
                     "imdb_id":"tt15239678","overview":"Paul faces a choice."}
                    """);
            }

            return StubHttpMessageHandler.Status(HttpStatusCode.NotFound);
        });

        var match = await Client(handler).SearchAnyAsync("Dune 2", default);

        Assert.NotNull(match);
        Assert.Equal(MediaType.Movie, match!.MediaType);
        Assert.Equal(693134, match.TmdbId);
        Assert.Equal("Dune: Part Two", match.Title);
        Assert.Equal(2024, match.Year);
        Assert.Equal(167, match.RuntimeMinutes);
        Assert.Equal("https://image.tmdb.org/t/p/w500/dune.jpg", match.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/dune-bg.jpg", match.BackdropUrl);
    }

    [Fact]
    public async Task SearchCandidates_PreservesMediaOrderingAndIncludesDiscoveryArtwork()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            Assert.EndsWith("/search/multi", req.RequestUri!.AbsolutePath, StringComparison.Ordinal);
            return Json("""
                {"results":[
                  {"id":99,"media_type":"person","name":"Someone"},
                  {"id":693134,"media_type":"movie","title":"Dune: Part Two",
                   "release_date":"2024-02-27","poster_path":"/dune.jpg",
                   "backdrop_path":"/dune-bg.jpg","overview":"Paul faces a choice."},
                  {"id":90228,"media_type":"tv","name":"Dune: Prophecy",
                   "first_air_date":"2024-11-17","poster_path":"/prophecy.jpg"},
                  {"id":693134,"media_type":"movie","title":"duplicate"}
                ]}
                """);
        });

        var matches = await Client(handler).SearchCandidatesAsync("Dune 2", null, default);

        Assert.Collection(
            matches,
            movie =>
            {
                Assert.Equal(MediaType.Movie, movie.MediaType);
                Assert.Equal(693134, movie.TmdbId);
                Assert.Equal("Dune: Part Two", movie.Title);
                Assert.Equal(2024, movie.Year);
                Assert.Equal("https://image.tmdb.org/t/p/w500/dune.jpg", movie.PosterUrl);
                Assert.Equal("https://image.tmdb.org/t/p/w1280/dune-bg.jpg", movie.BackdropUrl);
            },
            show =>
            {
                Assert.Equal(MediaType.Tv, show.MediaType);
                Assert.Equal(90228, show.TmdbId);
                Assert.Equal("Dune: Prophecy", show.Title);
                Assert.Equal("https://image.tmdb.org/t/p/w500/prophecy.jpg", show.PosterUrl);
            });
        Assert.Single(handler.Requests);
    }

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
        Assert.Contains("primary_release_year=2021", handler.Requests[0].Query, StringComparison.Ordinal);
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
    public async Task TvSeriesCatalog_ReadsOrderedSeasonDirectory()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            Assert.EndsWith("/tv/37680", req.RequestUri!.AbsolutePath, StringComparison.Ordinal);
            return Json("""
                {"id":37680,"name":"Suits","first_air_date":"2011-06-23",
                 "overview":"A legal drama.","poster_path":"/suits.jpg",
                 "episode_run_time":[42],"external_ids":{"imdb_id":"tt1632701"},
                 "seasons":[
                   {"season_number":2,"name":"Season 2","episode_count":16,"air_date":"2012-06-14","poster_path":"/s2.jpg"},
                   {"season_number":0,"name":"Specials","episode_count":2,"air_date":null},
                   {"season_number":1,"name":"Season 1","episode_count":12,"air_date":"2011-06-23","poster_path":"/s1.jpg"}
                 ]}
                """);
        });

        var catalog = await Client(handler).GetTvSeriesCatalogAsync(37680, default);

        Assert.NotNull(catalog);
        Assert.Equal("Suits", catalog!.Series.Title);
        Assert.Equal("tt1632701", catalog.Series.ImdbId);
        Assert.Equal([0, 1, 2], catalog.Seasons.Select(season => season.SeasonNumber));
        Assert.Equal(12, catalog.Seasons[1].EpisodeCount);
        Assert.Equal("https://image.tmdb.org/t/p/w500/s1.jpg", catalog.Seasons[1].PosterUrl);
    }

    [Fact]
    public async Task TvSeasonCatalog_ReadsCanonicalEpisodesAndStillArtwork()
    {
        var handler = new StubHttpMessageHandler(req =>
        {
            Assert.EndsWith("/tv/37680/season/1", req.RequestUri!.AbsolutePath, StringComparison.Ordinal);
            return Json("""
                {"name":"Season 1","season_number":1,"air_date":"2011-06-23",
                 "poster_path":"/season.jpg","episodes":[
                   {"episode_number":2,"name":"Errors and Omissions","air_date":"2011-06-30","runtime":43,"still_path":"/e2.jpg","overview":"Harvey faces a problem."},
                   {"episode_number":1,"name":"Pilot","air_date":"2011-06-23","runtime":72,"still_path":"/e1.jpg"},
                   {"episode_number":0,"name":"invalid"}
                 ]}
                """);
        });

        var season = await Client(handler).GetTvSeasonCatalogAsync(37680, 1, default);

        Assert.NotNull(season);
        Assert.Equal("Season 1", season!.Title);
        Assert.Equal([1, 2], season.Episodes.Select(episode => episode.EpisodeNumber));
        Assert.Equal("Pilot", season.Episodes[0].Title);
        Assert.Equal(72, season.Episodes[0].RuntimeMinutes);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/e1.jpg", season.Episodes[0].StillUrl);
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
    public async Task Cache_RetriesImmediatelyAfterTransientTmdbFailure()
    {
        var attempts = 0;
        var handler = new StubHttpMessageHandler(_ =>
            Interlocked.Increment(ref attempts) == 1
                ? StubHttpMessageHandler.Status(HttpStatusCode.ServiceUnavailable)
                : Json("""{"results":[{"id":693134,"media_type":"movie","title":"Dune: Part Two"}]}"""));
        var caching = new CachingTmdbClient(Client(handler), TimeSpan.FromHours(24));

        Assert.Empty(await caching.SearchCandidatesAsync("Dune 2", null, default));
        var match = Assert.Single(await caching.SearchCandidatesAsync("Dune 2", null, default));

        Assert.Equal(693134, match.TmdbId);
        Assert.Equal(2, attempts);
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task TransientHttpStatus_IsDistinguishedFromAuthoritativeMiss(HttpStatusCode status)
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(status));

        await Assert.ThrowsAsync<TmdbTransientException>(
            () => Client(handler).SearchMovieAsync("Example", null, default));
    }

    [Fact]
    public async Task TransportFailure_IsDistinguishedFromAuthoritativeMiss()
    {
        var handler = new StubHttpMessageHandler(_ => throw new HttpRequestException("temporary transport failure"));

        await Assert.ThrowsAsync<TmdbTransientException>(
            () => Client(handler).SearchMovieAsync("Example", null, default));
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

    [Fact]
    public async Task ReadAccessToken_UsesBearerHeaderAndNeverAppearsInUrl()
    {
        const string token = "eyJheader.payload.signature";
        string? scheme = null;
        string? parameter = null;
        var handler = new StubHttpMessageHandler(req =>
        {
            scheme = req.Headers.Authorization?.Scheme;
            parameter = req.Headers.Authorization?.Parameter;
            return Json("""{"results":[]}""");
        });

        await Client(handler, apiKey: token).SearchCandidatesAsync("Dune 2", null, default);

        Assert.Equal("Bearer", scheme);
        Assert.Equal(token, parameter);
        var request = Assert.Single(handler.Requests);
        Assert.DoesNotContain(token, request.AbsoluteUri, StringComparison.Ordinal);
        Assert.DoesNotContain("api_key=", request.Query, StringComparison.Ordinal);
    }

    [Fact]
    public void CredentialHelpers_NormalizePastedBearerPrefix()
    {
        const string token = "eyJheader.payload.signature";

        Assert.Equal(token, TmdbOptions.NormalizeCredential($"  Bearer {token}  "));
        Assert.True(TmdbOptions.IsBearerCredential(token));
        Assert.False(TmdbOptions.IsBearerCredential("0123456789abcdef0123456789abcdef"));
    }

    [Fact]
    public async Task CredentialAndRevision_ArePublishedAsOneAtomicSnapshot()
    {
        var options = new TmdbOptions();
        const int updates = 10_000;

        var writer = Task.Run(() =>
        {
            for (var i = 0; i < updates; i++)
                options.ApiKey = $"key-{i}";
        });
        var reader = Task.Run(() =>
        {
            while (!writer.IsCompleted)
            {
                var snapshot = options.CredentialSnapshot;
                if (snapshot.ApiKey.Length == 0)
                {
                    Assert.Equal(0, snapshot.Revision);
                    continue;
                }

                var index = int.Parse(snapshot.ApiKey.AsSpan("key-".Length));
                Assert.Equal(index + 1, snapshot.Revision);
            }
        });

        await Task.WhenAll(writer, reader);
        Assert.Equal(("key-9999", 10_000), options.CredentialSnapshot);
    }

    [Fact]
    public async Task RejectsOversizedUnknownLengthResponseAfterTheConfiguredLimit()
    {
        var body = Encoding.UTF8.GetBytes("{\"results\":[" + new string(' ', 8_192) + "]}");
        var handler = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new UnknownLengthContent(body),
        });
        var client = new TmdbClient(
            new HttpClient(handler),
            new TmdbOptions { ApiKey = "test-key", MaxResponseBytes = 1_024 });

        Assert.Null(await client.SearchMovieAsync("Example", null, default));
    }

    [Fact]
    public async Task RejectsOversizedDeclaredResponseWithoutReadingIt()
    {
        var handler = new StubHttpMessageHandler(_ => Json("{\"results\":[" + new string(' ', 8_192) + "]}"));
        var client = new TmdbClient(
            new HttpClient(handler),
            new TmdbOptions { ApiKey = "test-key", MaxResponseBytes = 1_024 });

        Assert.Null(await client.SearchMovieAsync("Example", null, default));
    }

    [Fact]
    public async Task DetailResponse_DropsOversizedOrUnsafeMetadataFields()
    {
        var oversizedTitle = new string('x', 513);
        var handler = new StubHttpMessageHandler(_ => Json($$"""
            {"id":1,"title":"{{oversizedTitle}}","original_title":"Safe fallback",
             "overview":"unsafe\u0000text","poster_path":"https://elsewhere.example/p.jpg",
             "backdrop_path":"/safe.jpg","runtime":100001,"release_date":"9999-01-01",
             "imdb_id":"{{new string('i', 33)}}"}
            """));

        var match = await Client(handler).GetMovieAsync(1, default);

        Assert.NotNull(match);
        Assert.Equal("Safe fallback", match!.Title);
        Assert.Null(match.Overview);
        Assert.Null(match.PosterUrl);
        Assert.Equal("https://image.tmdb.org/t/p/w1280/safe.jpg", match.BackdropUrl);
        Assert.Null(match.RuntimeMinutes);
        Assert.Null(match.Year);
        Assert.Null(match.ImdbId);
    }
}
