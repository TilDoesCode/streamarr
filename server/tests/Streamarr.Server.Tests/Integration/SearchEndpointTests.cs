using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// End-to-end coverage of the M2 search pipeline (BRIEF §6.2): canned indexer results
/// + a mocked TMDB client → sanely ranked works; samples/fakes rejected with reasons;
/// NZB URLs never cross the wire. Runs the real controller + DI graph via
/// <see cref="WebApplicationFactory{TEntryPoint}"/>, replacing only the two external
/// boundaries (indexer HTTP + TMDB HTTP) with fakes.
/// </summary>
public sealed class SearchEndpointTests : IClassFixture<SearchEndpointTests.Factory>
{
    private const string ApiKey = "test-api-key-aaaaaaaaaaaaaaaaaaaa";
    private const string NzbSecret = "secret.example";

    private readonly Factory _factory;

    public SearchEndpointTests(Factory factory) => _factory = factory;

    /// <summary>A machine-key client — /search is in the machine scope (BRIEF §6.4).</summary>
    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        return client;
    }

    /// <summary>An admin-authenticated client — /debug/search is admin-only (BRIEF §6.4).</summary>
    private HttpClient AdminClient()
    {
        var client = _factory.CreateClient();
        client.AuthenticateAsAdminAsync().GetAwaiter().GetResult();
        return client;
    }

    [Fact]
    public async Task Search_AggregatesRankedWork_WithTmdbMetadata()
    {
        using var client = Client();

        var response = await client.GetFromJsonAsync<SearchResponse>("/api/v1/search?q=Example+Movie&type=movie");

        Assert.NotNull(response);
        var work = Assert.Single(response!.Results);
        Assert.Equal("tmdb-movie-12345", work.WorkId);
        Assert.Equal("movie", work.MediaType);
        Assert.Equal("Example Movie", work.Title);
        Assert.Equal(12345, work.TmdbId);
        Assert.Equal("tt1234567", work.ImdbId);
        Assert.Equal(120, work.RuntimeMinutes);
        Assert.False(string.IsNullOrEmpty(work.PosterUrl));

        Assert.Equal(2, work.Releases.Count);
        Assert.All(work.Releases, release => Assert.False(release.Rejected));

        // The top release is a fully-parsed, accepted release with a score.
        var top = work.Releases[0];
        Assert.False(top.Rejected);
        Assert.True(top.Score > 0);
        Assert.Equal("1080p", top.Quality.Resolution);
    }

    [Fact]
    public async Task Search_ResolvesSemanticAlias_AndReturnsCanonicalAvailableMovieOnly()
    {
        using var client = Client();

        var response = await client.GetFromJsonAsync<SearchResponse>("/api/v1/search?q=Dune+2");

        Assert.NotNull(response);
        var work = Assert.Single(response!.Results);
        Assert.Equal("tmdb-movie-693134", work.WorkId);
        Assert.Equal("Dune: Part Two", work.Title);
        Assert.Equal(2024, work.Year);
        Assert.Equal(693134, work.TmdbId);
        Assert.Equal("tt15239678", work.ImdbId);
        Assert.Equal(167, work.RuntimeMinutes);
        Assert.Equal("https://image.example/poster/dune-part-two.jpg", work.PosterUrl);
        Assert.Equal("https://image.example/backdrop/dune-part-two.jpg", work.BackdropUrl);
        Assert.Equal("Paul Atreides unites with Chani and the Fremen.", work.Overview);

        var release = Assert.Single(work.Releases);
        Assert.Equal("Dune.Part.Two.2024.1080p.WEB-DL.x265.DDP5.1-GROUP", release.Title);
        Assert.False(release.Rejected);
    }

    [Fact]
    public async Task Search_IntersectsMultipleTmdbCandidates_WithAvailableReleasesAndMergesAliases()
    {
        using var client = Client();

        var response = await client.GetFromJsonAsync<SearchResponse>("/api/v1/search?q=Dune+catalog");

        Assert.NotNull(response);
        Assert.Collection(
            response!.Results,
            movie =>
            {
                Assert.Equal("tmdb-movie-693134", movie.WorkId);
                Assert.Equal("Dune: Part Two", movie.Title);
                Assert.Equal("https://image.example/poster/dune-part-two.jpg", movie.PosterUrl);
                Assert.Equal(2, movie.Releases.Count);
            },
            episode =>
            {
                Assert.Equal("tmdb-tv-90228-s01e04", episode.WorkId);
                Assert.Equal("Dune: Prophecy", episode.Title);
                Assert.Equal("tv", episode.MediaType);
                Assert.Equal("https://image.example/poster/dune-prophecy.jpg", episode.PosterUrl);
                Assert.Single(episode.Releases);
            });
        Assert.DoesNotContain(response.Results, work => work.Title.Contains("Dirt", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Search_HidesWorkWhenEveryReleaseFailsQualityChecks_ButDebugKeepsIt()
    {
        using var client = Client();
        var publicResponse = await client.GetFromJsonAsync<SearchResponse>(
            "/api/v1/search?q=Unavailable+Movie&type=movie");

        Assert.NotNull(publicResponse);
        Assert.Empty(publicResponse!.Results);

        using var admin = AdminClient();
        var debugResponse = await admin.PostAsJsonAsync(
            "/api/v1/debug/search",
            new { q = "Unavailable Movie", type = "movie" });
        debugResponse.EnsureSuccessStatusCode();
        using var debug = JsonDocument.Parse(await debugResponse.Content.ReadAsStringAsync());
        var debugWork = Assert.Single(debug.RootElement.GetProperty("results").EnumerateArray());
        var releases = debugWork.GetProperty("releases").EnumerateArray().ToArray();
        Assert.NotEmpty(releases);
        Assert.All(releases, release => Assert.True(release.GetProperty("rejected").GetBoolean()));
    }

    [Fact]
    public async Task Search_HidesUnidentifiedIndexerBuckets_ButDebugKeepsThem()
    {
        using var client = Client();
        var indexerSearchesBefore = FakeSearchNewznabClient.RawOnlySearches;
        var publicResponse = await client.GetFromJsonAsync<SearchResponse>("/api/v1/search?q=Raw+only");

        Assert.NotNull(publicResponse);
        Assert.Empty(publicResponse!.Results);
        Assert.Equal(indexerSearchesBefore, FakeSearchNewznabClient.RawOnlySearches);

        using var admin = AdminClient();
        var debugResponse = await admin.PostAsJsonAsync("/api/v1/debug/search", new { q = "Raw only" });
        debugResponse.EnsureSuccessStatusCode();
        using var debug = JsonDocument.Parse(await debugResponse.Content.ReadAsStringAsync());
        var work = Assert.Single(debug.RootElement.GetProperty("results").EnumerateArray());
        Assert.StartsWith("unmatched-", work.GetProperty("workId").GetString(), StringComparison.Ordinal);
        Assert.Equal(indexerSearchesBefore + 1, FakeSearchNewznabClient.RawOnlySearches);
    }

    [Fact]
    public async Task Search_WithExplicitTmdbId_ReturnsOnlyTitlesMatchingThatWork()
    {
        using var client = Client();

        var response = await client.GetFromJsonAsync<SearchResponse>(
            "/api/v1/search?q=ignored&type=movie&tmdbId=693134");

        var work = Assert.Single(response!.Results);
        Assert.Equal(693134, work.TmdbId);
        Assert.All(work.Releases, release =>
            Assert.Contains("Dune", release.Title, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Search_WithUnknownExplicitTmdbId_DoesNotFanOutToIndexers()
    {
        using var client = Client();
        var searchesBefore = FakeSearchNewznabClient.TotalSearches;

        var response = await client.GetFromJsonAsync<SearchResponse>(
            "/api/v1/search?q=ignored&type=movie&tmdbId=999999");

        Assert.Empty(response!.Results);
        Assert.Equal(searchesBefore, FakeSearchNewznabClient.TotalSearches);
    }

    [Fact]
    public async Task Search_NeverExposesNzbUrl()
    {
        using var client = Client();

        var raw = await client.GetStringAsync("/api/v1/search?q=Example+Movie&type=movie");

        Assert.DoesNotContain(NzbSecret, raw);
        Assert.DoesNotContain("nzbUrl", raw, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task TvSearch_ReturnsOnlyTopThreeSeriesWithoutTouchingIndexers()
    {
        using var client = Client();
        var before = FakeSearchNewznabClient.SuitsSeasonSearches;

        var response = await client.GetFromJsonAsync<TvSeriesSearchResponse>("/api/v1/tv/search?q=Suits");

        Assert.NotNull(response);
        Assert.Equal(3, response!.Results.Count);
        Assert.Equal("Suits", response.Results[0].Title);
        Assert.Equal(37680, response.Results[0].TmdbId);
        Assert.All(response.Results, series => Assert.Equal("series", series.MediaType));
        Assert.Equal(before, FakeSearchNewznabClient.SuitsSeasonSearches);
    }

    [Fact]
    public async Task TvSeries_ReturnsSeasonDirectoryWithoutTouchingIndexers()
    {
        using var client = Client();
        var before = FakeSearchNewznabClient.SuitsSeasonSearches;

        var response = await client.GetFromJsonAsync<TvSeriesDetailsResponse>("/api/v1/tv/37680");

        Assert.NotNull(response);
        Assert.Equal("Suits", response!.Series.Title);
        Assert.Equal(2, response.Series.SeasonCount);
        Assert.Equal(6, response.Series.EpisodeCount);
        Assert.Equal([0, 1, 2], response.Seasons.Select(season => season.SeasonNumber));
        Assert.Equal(before, FakeSearchNewznabClient.SuitsSeasonSearches);
    }

    [Fact]
    public async Task TvSeason_QueriesIndexerOnceAndOverlaysAvailabilityAcrossAllEpisodes()
    {
        using var client = Client();
        var before = FakeSearchNewznabClient.SuitsSeasonSearches;

        var response = await client.GetFromJsonAsync<TvSeasonDetailsResponse>(
            "/api/v1/tv/37680/seasons/1");

        Assert.NotNull(response);
        Assert.Equal(before + 1, FakeSearchNewznabClient.SuitsSeasonSearches);
        Assert.Equal(3, response!.Episodes.Count);
        Assert.Equal("Pilot", response.Episodes[0].Title);
        Assert.Equal(2, response.Episodes[0].Releases.Count);
        Assert.Single(response.Episodes[1].Releases);
        Assert.Empty(response.Episodes[2].Releases);
        Assert.All(response.Episodes, episode => Assert.Equal("Suits", episode.SeriesTitle));
        Assert.Single(response.Indexers);
        Assert.Equal("succeeded", response.Indexers[0].Status);
    }

    [Fact]
    public async Task Search_RequiresAuthentication()
    {
        using var client = _factory.CreateClient(); // no bearer token
        var response = await client.GetAsync("/api/v1/search?q=Example");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Search_RejectsEmptyQuery()
    {
        using var client = Client();
        var response = await client.GetAsync("/api/v1/search");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task DebugSearch_ReturnsParsedFieldsScoreBreakdownAndRejectionReasons()
    {
        using var client = AdminClient();

        var response = await client.PostAsJsonAsync("/api/v1/debug/search", new { q = "Example Movie", type = "movie" });
        response.EnsureSuccessStatusCode();

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;

        var indexers = root.GetProperty("indexers");
        Assert.Equal(1, indexers.GetArrayLength());
        Assert.Equal("succeeded", indexers[0].GetProperty("status").GetString());

        var work = root.GetProperty("results")[0];
        var releases = work.GetProperty("releases");
        Assert.Equal(4, releases.GetArrayLength());

        // Every debug release exposes its parse and per-rule score breakdown.
        foreach (var release in releases.EnumerateArray())
        {
            Assert.True(release.TryGetProperty("parsed", out _));
            Assert.True(release.TryGetProperty("scoreBreakdown", out var breakdown));
            Assert.True(breakdown.ValueKind == JsonValueKind.Array);
        }

        var codes = releases.EnumerateArray()
            .SelectMany(r => r.GetProperty("rejections").EnumerateArray())
            .Select(rej => rej.GetProperty("code").GetString())
            .ToArray();

        Assert.Contains("sample", codes);
        Assert.Contains("size-too-small", codes);
    }

    [Fact]
    public async Task DebugSearch_NeverExposesNzbUrl()
    {
        using var client = AdminClient();
        var response = await client.PostAsJsonAsync("/api/v1/debug/search", new { q = "Example Movie", type = "movie" });
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(NzbSecret, raw);
    }

    // Powers the Management UI live preview (BRIEF §9.1): an unsaved draft profile sent in
    // the request must reorder the ranked releases without any profile being saved first.
    [Fact]
    public async Task DebugSearch_DraftProfile_ReordersReleases()
    {
        using var client = AdminClient();

        static async Task<string> TopReleaseId(HttpResponseMessage response)
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return doc.RootElement.GetProperty("results")[0].GetProperty("releases")[0]
                .GetProperty("releaseId").GetString()!;
        }

        // Default profile prefers 1080p over 2160p, so the 1080p WEB-DL tops the list.
        var withDefault = await client.PostAsJsonAsync("/api/v1/debug/search", new { q = "Example Movie", type = "movie" });
        withDefault.EnsureSuccessStatusCode();
        var defaultTop = await TopReleaseId(withDefault);

        // A draft that prefers 2160p first must flip the ordering — proving the endpoint
        // ranks with the inline draft, not the stored/default profile.
        var draft = new
        {
            q = "Example Movie",
            type = "movie",
            profile = new
            {
                name = "Draft 2160p-first",
                preferredResolutions = new[] { "2160p", "1080p", "720p" },
                preferredSources = new[] { "BluRay", "WEB-DL" },
                resolutionWeight = 1000,
            },
        };
        var withDraft = await client.PostAsJsonAsync("/api/v1/debug/search", draft);
        withDraft.EnsureSuccessStatusCode();
        var draftTop = await TopReleaseId(withDraft);

        Assert.NotEqual(defaultTop, draftTop);

        // Public discovery drops broad substring noise, but the same semantic search keeps
        // that raw parser bucket available to operators in diagnostics.
        var diagnosticResponse = await client.PostAsJsonAsync(
            "/api/v1/debug/search",
            new { q = "Dune catalog" });
        diagnosticResponse.EnsureSuccessStatusCode();
        using var diagnostic = JsonDocument.Parse(await diagnosticResponse.Content.ReadAsStringAsync());
        Assert.Contains(
            diagnostic.RootElement.GetProperty("results").EnumerateArray(),
            work => work.GetProperty("title").GetString()!.Contains("Dirt", StringComparison.OrdinalIgnoreCase));
    }

    // ---- test host ------------------------------------------------------------------

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-search-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:ApiKey"] = ApiKey,
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
                ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
                ["Streamarr:Indexers:0:Name"] = "mock",
                ["Streamarr:Indexers:0:BaseUrl"] = "https://mock.example",
                ["Streamarr:Indexers:0:ApiKey"] = "mockkey",
                ["Streamarr:Indexers:0:Categories:0"] = "2000",
            }));

            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<INewznabClient>();
                services.AddSingleton<INewznabClient>(new FakeSearchNewznabClient());

                services.RemoveAll<ITmdbClient>();
                services.AddSingleton<ITmdbClient>(new FakeSearchTmdbClient());
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }

    /// <summary>Returns a fixed page of releases: two good, one sample, one undersized fake.</summary>
    private sealed class FakeSearchNewznabClient : INewznabClient
    {
        public static int SuitsSeasonSearches;
        public static int RawOnlySearches;
        public static int TotalSearches;

        private static readonly NewznabItem[] ExampleItems =
        [
            Item("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", 5_000_000_000, "good-1080", grabs: 34),
            Item("Example.Movie.2021.2160p.BluRay.x265.HDR10-GROUP", 25_000_000_000, "good-2160", grabs: 12),
            Item("Example.Movie.2021.1080p.WEB-DL.x264.sample-GROUP", 4_000_000_000, "sample", grabs: 1),
            Item("Example.Movie.2021.1080p.WEB-DL.x264-FAKE", 1_000_000, "fake", grabs: 0),
        ];

        private static readonly NewznabItem[] DuneItems =
        [
            Item("Dune.Part.Two.2024.1080p.WEB-DL.x265.DDP5.1-GROUP", 7_000_000_000, "dune-good", grabs: 95),
            Item("Dune.Part.Two.2024.1080p.WEB-DL.x264.sample-GROUP", 5_000_000_000, "dune-sample", grabs: 1),
            Item("Other.Movie.2024.1080p.WEB-DL.x265-GROUP", 5_000_000_000, "explicit-id-noise", grabs: 20),
        ];

        private static readonly NewznabItem[] DuneCatalogItems =
        [
            Item("Dune.Part.Two.2024.1080p.WEB-DL.x265.DDP5.1-GROUP", 7_000_000_000, "catalog-dune-two", grabs: 95),
            Item("Dune.Part.2.2024.2160p.BluRay.x265.HDR-GROUP", 20_000_000_000, "catalog-dune-2", grabs: 80),
            Item("Dune.Prophecy.S01E04.1080p.WEB-DL.x265-GROUP", 3_000_000_000, "catalog-prophecy", grabs: 55),
            Item("Dirt.Every.Day.S07E05.Junkyard.Dune.Machines.1080p.WEB-DL.x265-GROUP", 2_000_000_000, "catalog-noise", grabs: 10),
        ];

        private static readonly NewznabItem[] UnavailableItems =
        [
            Item("Unavailable.Movie.2024.1080p.WEB-DL.x264.sample-GROUP", 4_000_000_000, "unavailable-sample", grabs: 1),
            Item("Unavailable.Movie.2024.1080p.WEB-DL.x264-FAKE", 1_000_000, "unavailable-fake", grabs: 0),
        ];

        private static readonly NewznabItem[] RawOnlyItems =
        [
            Item("Unidentified.Indexer.Bucket.2024.1080p.WEB-DL.x265-GROUP", 5_000_000_000, "raw-only", grabs: 5),
        ];

        private static readonly NewznabItem[] SuitsSeasonOneItems =
        [
            Item("Suits.S01E01.1080p.WEB-DL.x265-GROUP", 3_000_000_000, "suits-s01e01-a", grabs: 70),
            Item("Suits.S01E01.720p.WEB-DL.x264-GROUP", 1_500_000_000, "suits-s01e01-b", grabs: 40),
            Item("Suits.S01E02.1080p.WEB-DL.x265-GROUP", 3_100_000_000, "suits-s01e02", grabs: 65),
            Item("Suits.S01.1080p.WEB-DL.x265-GROUP", 30_000_000_000, "suits-s01-pack", grabs: 90),
        ];

        public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
            => Task.FromResult(new NewznabCapabilities());

        public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref TotalSearches);
            if (query is { TmdbId: 37680, Season: 1, Episode: null })
            {
                Interlocked.Increment(ref SuitsSeasonSearches);
                return Task.FromResult(new NewznabSearchResponse { Items = SuitsSeasonOneItems });
            }

            if (string.Equals(query.Term, "Raw only", StringComparison.OrdinalIgnoreCase))
            {
                Interlocked.Increment(ref RawOnlySearches);
                return Task.FromResult(new NewznabSearchResponse { Items = RawOnlyItems });
            }

            var items = string.Equals(query.Term, "Dune catalog", StringComparison.OrdinalIgnoreCase)
                ? DuneCatalogItems
                : query.TmdbId switch
                    {
                        693134 => DuneItems,
                        900001 => UnavailableItems,
                        _ => ExampleItems,
                    };
            return Task.FromResult(new NewznabSearchResponse { Items = items });
        }

        private static NewznabItem Item(string title, long size, string guid, int grabs)
            => new()
            {
                Title = title,
                Guid = guid,
                SizeBytes = size,
                Grabs = grabs,
                NzbUrl = $"https://{NzbSecret}/{guid}.nzb",
            };
    }

    /// <summary>Resolves the "Example Movie" work to a fixed TMDB match with a runtime.</summary>
    private sealed class FakeSearchTmdbClient : ITmdbClient
    {
        private static readonly TmdbMatch ExampleMovie = new()
        {
            MediaType = MediaType.Movie,
            TmdbId = 12345,
            ImdbId = "tt1234567",
            Title = "Example Movie",
            Year = 2021,
            RuntimeMinutes = 120,
            PosterUrl = "https://image.example/poster/12345.jpg",
            Overview = "An example work.",
        };

        private static readonly TmdbMatch DunePartTwo = new()
        {
            MediaType = MediaType.Movie,
            TmdbId = 693134,
            ImdbId = "tt15239678",
            Title = "Dune: Part Two",
            Year = 2024,
            RuntimeMinutes = 167,
            PosterUrl = "https://image.example/poster/dune-part-two.jpg",
            BackdropUrl = "https://image.example/backdrop/dune-part-two.jpg",
            Overview = "Paul Atreides unites with Chani and the Fremen.",
        };

        private static readonly TmdbMatch UnavailableMovie = new()
        {
            MediaType = MediaType.Movie,
            TmdbId = 900001,
            ImdbId = "tt9000010",
            Title = "Unavailable Movie",
            Year = 2024,
            RuntimeMinutes = 120,
            PosterUrl = "https://image.example/poster/unavailable.jpg",
        };

        private static readonly TmdbMatch DuneProphecy = new()
        {
            MediaType = MediaType.Tv,
            TmdbId = 90228,
            ImdbId = "tt10466872",
            Title = "Dune: Prophecy",
            Year = 2024,
            RuntimeMinutes = 60,
            PosterUrl = "https://image.example/poster/dune-prophecy.jpg",
        };

        private static readonly TmdbMatch Suits = new()
        {
            MediaType = MediaType.Tv,
            TmdbId = 37680,
            ImdbId = "tt1632701",
            Title = "Suits",
            Year = 2011,
            RuntimeMinutes = 42,
            PosterUrl = "https://image.example/poster/suits.jpg",
            BackdropUrl = "https://image.example/backdrop/suits.jpg",
            Overview = "A legal drama.",
        };

        private static readonly TmdbMatch SuitsLa = new()
        {
            MediaType = MediaType.Tv,
            TmdbId = 259453,
            Title = "Suits LA",
            Year = 2025,
        };

        private static readonly TmdbMatch SuitsKorea = new()
        {
            MediaType = MediaType.Tv,
            TmdbId = 79257,
            Title = "Suits",
            Year = 2018,
        };

        private static readonly TmdbMatch FourthSuitsMatch = new()
        {
            MediaType = MediaType.Tv,
            TmdbId = 999004,
            Title = "Suits: Another Match",
            Year = 2026,
        };

        public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(
            string query,
            MediaType? mediaType,
            CancellationToken cancellationToken)
        {
            IReadOnlyList<TmdbMatch> matches = query.Equals("Dune catalog", StringComparison.OrdinalIgnoreCase)
                ? [DunePartTwo, DuneProphecy]
                : query.Equals("Suits", StringComparison.OrdinalIgnoreCase) && mediaType == MediaType.Tv
                    ? [Suits, SuitsLa, SuitsKorea, FourthSuitsMatch]
                : query.Equals("Dune 2", StringComparison.OrdinalIgnoreCase)
                    ? [DunePartTwo]
                    : query.Equals("Raw only", StringComparison.OrdinalIgnoreCase)
                        ? []
                    : query.Equals("Unavailable Movie", StringComparison.OrdinalIgnoreCase)
                        ? [UnavailableMovie]
                        : [ExampleMovie];
            return Task.FromResult(matches);
        }

        public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
            => Task.FromResult<TmdbMatch?>(
                query.Equals("Dune 2", StringComparison.OrdinalIgnoreCase) ? DunePartTwo : ExampleMovie);

        public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
            => Task.FromResult<TmdbMatch?>(
                title.Equals("Unidentified Indexer Bucket", StringComparison.OrdinalIgnoreCase)
                    ? null
                    : title.Equals("Unavailable Movie", StringComparison.OrdinalIgnoreCase)
                    ? UnavailableMovie
                    : title.Equals("Dune 2", StringComparison.OrdinalIgnoreCase)
                        ? DunePartTwo
                        : ExampleMovie);

        public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);
        public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
            => Task.FromResult<TmdbMatch?>(tmdbId switch
            {
                693134 => DunePartTwo,
                900001 => UnavailableMovie,
                12345 => ExampleMovie,
                _ => null,
            });
        public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
            => Task.FromResult<TmdbMatch?>(tmdbId == Suits.TmdbId ? Suits : null);

        public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
            => Task.FromResult<TmdbTvSeriesCatalog?>(tmdbId == Suits.TmdbId
                ? new TmdbTvSeriesCatalog
                {
                    Series = Suits,
                    Seasons =
                    [
                        new TmdbSeasonSummary { SeasonNumber = 0, Title = "Specials", EpisodeCount = 1 },
                        new TmdbSeasonSummary { SeasonNumber = 1, Title = "Season 1", EpisodeCount = 3, PosterUrl = "https://image.example/poster/suits-s1.jpg" },
                        new TmdbSeasonSummary { SeasonNumber = 2, Title = "Season 2", EpisodeCount = 2 },
                    ],
                }
                : null);

        public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(
            int tmdbId,
            int seasonNumber,
            CancellationToken cancellationToken)
            => Task.FromResult<TmdbTvSeasonCatalog?>(tmdbId == Suits.TmdbId && seasonNumber == 1
                ? new TmdbTvSeasonCatalog
                {
                    TmdbId = tmdbId,
                    SeasonNumber = seasonNumber,
                    Title = "Season 1",
                    Episodes =
                    [
                        new TmdbEpisode { EpisodeNumber = 1, Title = "Pilot", RuntimeMinutes = 72, StillUrl = "https://image.example/still/suits-s01e01.jpg" },
                        new TmdbEpisode { EpisodeNumber = 2, Title = "Errors and Omissions", RuntimeMinutes = 43 },
                        new TmdbEpisode { EpisodeNumber = 3, Title = "Inside Track", RuntimeMinutes = 42 },
                    ],
                }
                : null);
        public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(ExampleMovie);
    }
}
