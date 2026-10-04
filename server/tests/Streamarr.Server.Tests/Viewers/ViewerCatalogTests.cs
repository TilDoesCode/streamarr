using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Core.Media;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>The viewer catalog over the real HTTP pipeline with fake TMDB and indexer boundaries.</summary>
public sealed class ViewerCatalogTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private const string Base = "/api/v1/viewer/catalog";
    private static readonly TimeSpan IndexerCacheLifetime = TimeSpan.FromSeconds(61);
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private async Task<HttpClient> ViewerAsync(string name, object? permissions = null, bool mustChangePassword = false)
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password, permissions, mustChangePassword });
        using var anon = factory.CreateClient();
        return factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password));
    }

    private Task<HttpClient> KidAsync() => ViewerAsync("kid", new { maxAge = 12, blockUnrated = true });

    private static async Task<JsonElement> OkAsync(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<JsonElement> ErrorAsync(HttpClient client, string path, HttpStatusCode status)
    {
        var response = await client.GetAsync(path);
        Assert.True(response.StatusCode == status, $"{path}: expected {(int)status}, got {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
    }

    private static int[] Ids(JsonElement items) => items.EnumerateArray().Select(i => i.GetProperty("tmdbId").GetInt32()).ToArray();

    private static JsonElement Row(JsonElement discover, string id)
        => discover.GetProperty("rows").EnumerateArray().Single(r => r.GetProperty("id").GetString() == id);

    [Fact]
    public async Task Search_ReturnsTmdbCandidates_WithoutAnyIndexerSearch()
    {
        using var viewer = await ViewerAsync("search");
        var searches = factory.Newznab.Searches;

        var any = await OkAsync(viewer, $"{Base}/search?q=movie");
        var shows = await OkAsync(viewer, $"{Base}/search?q=show&type=tv&limit=2");

        Assert.Equal([501, 502, 503, 504, 505], Ids(any.GetProperty("items")));
        var first = any.GetProperty("items")[0];
        Assert.Equal("tmdb-movie-501", first.GetProperty("workId").GetString());
        Assert.Equal("movie", first.GetProperty("mediaType").GetString());
        Assert.Equal("Katalogfilm", first.GetProperty("originalTitle").GetString());
        Assert.Equal("https://img.example/501-poster.jpg", first.GetProperty("posterUrl").GetString());
        Assert.Equal([600, 601], Ids(shows.GetProperty("items")));
        Assert.Equal("series", shows.GetProperty("items")[0].GetProperty("mediaType").GetString());
        Assert.Equal("tmdb-tv-600", shows.GetProperty("items")[0].GetProperty("workId").GetString());
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Theory]
    [InlineData("", "missing_query")]
    [InlineData("?q=%20", "missing_query")]
    [InlineData("?q=movie&type=music", "invalid_query")]
    [InlineData("?q=movie&limit=0", "invalid_query")]
    [InlineData("?q=movie&limit=21", "invalid_query")]
    [InlineData("?q=movie&limit=many", "invalid_request")]
    public async Task Search_RejectsInvalidQueries(string query, string code)
    {
        using var viewer = await ViewerAsync("badsearch");

        var error = await ErrorAsync(viewer, $"{Base}/search{query}", HttpStatusCode.BadRequest);

        Assert.Equal(code, error.GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("movies/abc")]
    [InlineData("series/600/seasons/one")]
    [InlineData("works/tmdb-movie-501/versions?refresh=maybe")]
    [InlineData("series/600/seasons/1?availability=yes")]
    public async Task MalformedValues_UseTheErrorEnvelope(string path)
    {
        using var viewer = await ViewerAsync("malformed");

        var error = await ErrorAsync(viewer, $"{Base}/{path}", HttpStatusCode.BadRequest);

        Assert.Equal("invalid_request", error.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Discover_ReturnsTrendingAndPopularRows_WithoutAnyIndexerSearch()
    {
        using var viewer = await ViewerAsync("discover");
        var searches = factory.Newznab.Searches;

        var discover = await OkAsync(viewer, $"{Base}/discover");

        Assert.Equal(
            ["trending-movies", "trending-series", "popular-movies", "popular-series"],
            discover.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("id").GetString()));
        var trending = Row(discover, "trending-movies");
        Assert.Equal(("trending", "movie"), (trending.GetProperty("kind").GetString(), trending.GetProperty("mediaType").GetString()));
        Assert.Equal([501, 502, 503, 504], Ids(trending.GetProperty("items")));
        Assert.Equal([600, 601], Ids(Row(discover, "trending-series").GetProperty("items")));
        Assert.Equal("series", Row(discover, "popular-series").GetProperty("mediaType").GetString());
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task Lists_HideTitlesAboveTheAgeLimit_AndUnratedOnesWhenBlocked()
    {
        using var kid = await KidAsync();
        using var teen = await ViewerAsync("teen", new { maxAge = 16, blockUnrated = false });

        var kidRows = await OkAsync(kid, $"{Base}/discover");
        var teenRows = await OkAsync(teen, $"{Base}/discover");
        var kidSearch = await OkAsync(kid, $"{Base}/search?q=movie");

        Assert.Equal([504], Ids(Row(kidRows, "trending-movies").GetProperty("items")));
        Assert.Equal([600], Ids(Row(kidRows, "trending-series").GetProperty("items")));
        Assert.Equal([504], Ids(Row(kidRows, "popular-movies").GetProperty("items")));
        Assert.DoesNotContain(kidRows.GetProperty("rows").EnumerateArray(), r => r.GetProperty("id").GetString() == "popular-series");
        Assert.Equal([504, 505], Ids(kidSearch.GetProperty("items")));
        Assert.Equal([501, 503, 504], Ids(Row(teenRows, "trending-movies").GetProperty("items")));
    }

    [Fact]
    public async Task Browse_PagesTmdbDiscover_AsCatalogItems_WithoutAnyIndexerSearch()
    {
        using var viewer = await ViewerAsync("browse");
        var searches = factory.Newznab.Searches;

        var first = await OkAsync(viewer, $"{Base}/browse?type=movie");
        var last = await OkAsync(viewer, $"{Base}/browse?type=movie&page=3");
        var series = await OkAsync(viewer, $"{Base}/browse?type=series&sort=top_rated");

        Assert.Equal(("movie", "popular", 1, 3, true), (first.GetProperty("mediaType").GetString(), first.GetProperty("sort").GetString(),
            first.GetProperty("page").GetInt32(), first.GetProperty("totalPages").GetInt32(), first.GetProperty("hasMore").GetBoolean()));
        Assert.Equal(JsonValueKind.Null, first.GetProperty("genre").ValueKind);
        Assert.Equal([501, 502], Ids(first.GetProperty("items")));
        var item = first.GetProperty("items")[0];
        Assert.Equal(("tmdb-movie-501", "movie"), (item.GetProperty("workId").GetString(), item.GetProperty("mediaType").GetString()));
        Assert.True(item.TryGetProperty("tint", out _) && item.TryGetProperty("tint2", out _) && item.TryGetProperty("spec", out _));
        Assert.Equal([505], Ids(last.GetProperty("items")));
        Assert.False(last.GetProperty("hasMore").GetBoolean());
        Assert.Equal([600, 601], Ids(series.GetProperty("items")));
        Assert.Equal(("series", "top_rated"), (series.GetProperty("mediaType").GetString(), series.GetProperty("sort").GetString()));
        Assert.Equal("tmdb-tv-600", series.GetProperty("items")[0].GetProperty("workId").GetString());
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task Genres_FollowTheViewersAcceptLanguage_WithVary()
    {
        using var viewer = await ViewerAsync("language");

        async Task<(string? Name, bool Vary)> MysteryAsync(string? language)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{Base}/genres?type=movie");
            if (language is not null)
                request.Headers.TryAddWithoutValidation("Accept-Language", language);
            using var response = await viewer.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var name = body.GetProperty("genres").EnumerateArray().Single(g => g.GetProperty("id").GetInt32() == 9648).GetProperty("name").GetString();
            return (name, response.Headers.Vary.Contains("Accept-Language"));
        }

        Assert.Equal(("Rätsel", true), await MysteryAsync("de-DE,de;q=0.9,en;q=0.8"));
        Assert.Equal(("Mystery", true), await MysteryAsync(null));
        Assert.Equal(("Mystery", true), await MysteryAsync("en"));
        Assert.Equal(("Mystery", true), await MysteryAsync("xx, tlh;q=0.5"));
        Assert.Equal(("Rätsel", true), await MysteryAsync("de"));
    }

    [Fact]
    public async Task Browse_PassesGenreAndSortToTmdb()
    {
        using var viewer = await ViewerAsync("browsegenre");

        var drama = await OkAsync(viewer, $"{Base}/browse?type=movie&genre={CatalogTmdbFake.DramaGenre}&sort=newest");

        Assert.Equal([501], Ids(drama.GetProperty("items")));
        Assert.Equal((CatalogTmdbFake.DramaGenre, "newest", false), (drama.GetProperty("genre").GetInt32(), drama.GetProperty("sort").GetString(),
            drama.GetProperty("hasMore").GetBoolean()));
        Assert.Equal(new Streamarr.Core.Tmdb.TmdbDiscoverQuery(MediaType.Movie, CatalogTmdbFake.DramaGenre, Streamarr.Core.Tmdb.TmdbDiscoverSort.Newest, 1),
            factory.Tmdb.LastDiscover);
        var newest = await OkAsync(viewer, $"{Base}/browse?type=tv&sort=NEWEST&page=1");
        Assert.Equal([602, 601], Ids(newest.GetProperty("items")));
    }

    [Fact]
    public async Task Browse_HidesTitlesAboveTheAgeLimit_ButKeepsPaging()
    {
        using var kid = await KidAsync();

        var first = await OkAsync(kid, $"{Base}/browse?type=movie&page=1");
        var second = await OkAsync(kid, $"{Base}/browse?type=movie&page=2");

        Assert.Empty(first.GetProperty("items").EnumerateArray());
        Assert.True(first.GetProperty("hasMore").GetBoolean());
        Assert.Equal([504], Ids(second.GetProperty("items")));
        Assert.Equal(3, second.GetProperty("totalPages").GetInt32());
    }

    [Theory]
    [InlineData("", "invalid_query")]
    [InlineData("?type=music", "invalid_query")]
    [InlineData("?type=movie&genre=0", "invalid_query")]
    [InlineData("?type=movie&sort=best", "invalid_query")]
    [InlineData("?type=movie&page=0", "invalid_query")]
    [InlineData("?type=movie&page=501", "invalid_query")]
    [InlineData("?type=movie&page=two", "invalid_request")]
    [InlineData("?type=movie&genre=drama", "invalid_request")]
    public async Task Browse_RejectsInvalidQueries(string query, string code)
    {
        using var viewer = await ViewerAsync("badbrowse");

        var error = await ErrorAsync(viewer, $"{Base}/browse{query}", HttpStatusCode.BadRequest);

        Assert.Equal(code, error.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Genres_ListTmdbGenresPerType()
    {
        using var viewer = await ViewerAsync("genres");

        var movies = await OkAsync(viewer, $"{Base}/genres?type=movie");
        var series = await OkAsync(viewer, $"{Base}/genres?type=series");

        Assert.Equal("movie", movies.GetProperty("mediaType").GetString());
        Assert.Equal([(18, "Drama"), (9648, "Mystery")],
            movies.GetProperty("genres").EnumerateArray().Select(g => (g.GetProperty("id").GetInt32(), g.GetProperty("name").GetString())));
        Assert.Equal("series", series.GetProperty("mediaType").GetString());
        Assert.Equal(10765, series.GetProperty("genres")[0].GetProperty("id").GetInt32());
        Assert.Equal("invalid_query", (await ErrorAsync(viewer, $"{Base}/genres", HttpStatusCode.BadRequest)).GetProperty("code").GetString());
        Assert.Equal("invalid_query", (await ErrorAsync(viewer, $"{Base}/genres?type=books", HttpStatusCode.BadRequest)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task MovieDetails_CarryMetadataWatchStateAndAccess()
    {
        using var viewer = await ViewerAsync("movie");
        var searches = factory.Newznab.Searches;

        var before = await OkAsync(viewer, $"{Base}/movies/501");
        var progress = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "progress", workId = "tmdb-movie-501", positionTicks = ViewerApi.Ticks(30), durationTicks = ViewerApi.Ticks(120),
        });
        progress.EnsureSuccessStatusCode();
        var after = await OkAsync(viewer, $"{Base}/movies/501");

        Assert.Equal("tmdb-movie-501", before.GetProperty("workId").GetString());
        Assert.Equal("Catalog Movie", before.GetProperty("title").GetString());
        Assert.Equal("Katalogfilm", before.GetProperty("originalTitle").GetString());
        Assert.Equal(2021, before.GetProperty("year").GetInt32());
        Assert.Equal("Every version counts.", before.GetProperty("tagline").GetString());
        Assert.Equal(["Drama", "Mystery"], before.GetProperty("genres").EnumerateArray().Select(g => g.GetString()));
        Assert.Equal(120, before.GetProperty("runtimeMinutes").GetInt32());
        Assert.Equal("PG-13", before.GetProperty("certification").GetString());
        Assert.Equal(7.8, before.GetProperty("voteAverage").GetDouble(), 3);
        Assert.Equal("https://img.example/501-logo.png", before.GetProperty("logoUrl").GetString());
        Assert.Equal("https://img.example/501-backdrop.jpg", before.GetProperty("backdropUrl").GetString());
        // not in TMDB's size layout: every size class is the original URL
        Assert.All(["small", "medium", "large"], c => Assert.Equal("https://img.example/501-backdrop.jpg", before.GetProperty("backdropSizes").GetProperty(c).GetString()));
        Assert.Equal("Ada Actor", before.GetProperty("people")[0].GetProperty("name").GetString());
        Assert.Equal(0, before.GetProperty("watch").GetProperty("positionTicks").GetInt64());
        Assert.True(before.GetProperty("access").GetProperty("allowed").GetBoolean());
        Assert.Equal("unrestricted", before.GetProperty("access").GetProperty("reason").GetString());
        Assert.Equal(ViewerApi.Ticks(30), after.GetProperty("watch").GetProperty("positionTicks").GetInt64());
        Assert.Equal(25.0, after.GetProperty("watch").GetProperty("progressPercent").GetDouble());
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task AgeGate_BlocksDetailsSeasonsAndVersions_WithReasonParams()
    {
        using var kid = await KidAsync();

        var rated = await ErrorAsync(kid, $"{Base}/movies/502", HttpStatusCode.Forbidden);
        var unrated = await ErrorAsync(kid, $"{Base}/movies/503", HttpStatusCode.Forbidden);

        Assert.Equal("age_restricted", rated.GetProperty("code").GetString());
        var parameters = rated.GetProperty("params");
        Assert.Equal("above_age_limit", parameters.GetProperty("reason").GetString());
        Assert.Equal("R", parameters.GetProperty("rating").GetString());
        Assert.Equal("17", parameters.GetProperty("minimumAge").GetString());
        Assert.Equal("12", parameters.GetProperty("viewerMaxAge").GetString());
        Assert.Equal("unrated_blocked", unrated.GetProperty("params").GetProperty("reason").GetString());
        foreach (var path in new[]
                 {
                     $"{Base}/works/tmdb-movie-502/versions", $"{Base}/series/601", $"{Base}/series/601/seasons/1",
                     $"{Base}/works/tmdb-tv-601-s01e01/versions", $"{Base}/works/tmdb-movie-503/versions",
                 })
        {
            Assert.Equal("age_restricted", (await ErrorAsync(kid, path, HttpStatusCode.Forbidden)).GetProperty("code").GetString());
        }

        var allowed = await OkAsync(kid, $"{Base}/movies/504");
        Assert.Equal("within_age_limit", allowed.GetProperty("access").GetProperty("reason").GetString());
        Assert.Equal("12", (await OkAsync(kid, $"{Base}/series/600")).GetProperty("certification").GetString());
    }

    [Fact]
    public async Task UnknownTitlesSeasonsAndEpisodes_Are404()
    {
        using var viewer = await ViewerAsync("missing");

        Assert.Equal("title_not_found", (await ErrorAsync(viewer, $"{Base}/movies/999", HttpStatusCode.NotFound)).GetProperty("code").GetString());
        Assert.Equal("title_not_found", (await ErrorAsync(viewer, $"{Base}/series/999", HttpStatusCode.NotFound)).GetProperty("code").GetString());
        Assert.Equal("title_not_found", (await ErrorAsync(viewer, $"{Base}/movies/0", HttpStatusCode.NotFound)).GetProperty("code").GetString());
        Assert.Equal("season_not_found", (await ErrorAsync(viewer, $"{Base}/series/600/seasons/9", HttpStatusCode.NotFound)).GetProperty("code").GetString());
        Assert.Equal("episode_not_found", (await ErrorAsync(viewer, $"{Base}/works/tmdb-tv-600-s01e09/versions", HttpStatusCode.NotFound)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task SeriesDetails_SummariseSeasonsAndSuggestTheNextEpisode()
    {
        using var viewer = await ViewerAsync("series");

        var fresh = await OkAsync(viewer, $"{Base}/series/600");
        Assert.Equal("tmdb-tv-600", fresh.GetProperty("workId").GetString());
        Assert.Equal(2, fresh.GetProperty("seasonCount").GetInt32());
        Assert.Equal(5, fresh.GetProperty("episodeCount").GetInt32());
        Assert.Equal("https://img.example/600-logo.png", fresh.GetProperty("logoUrl").GetString());
        Assert.Equal([0, 1, 2], fresh.GetProperty("seasons").EnumerateArray().Select(s => s.GetProperty("seasonNumber").GetInt32()));
        Assert.Equal("tmdb-tv-600-s01", fresh.GetProperty("seasons")[1].GetProperty("workId").GetString());
        var start = fresh.GetProperty("watch").GetProperty("nextEpisode");
        Assert.Equal(("tmdb-tv-600-s01e01", "start", 44), (start.GetProperty("workId").GetString(), start.GetProperty("reason").GetString(), start.GetProperty("runtimeMinutes").GetInt32()));

        (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-tv-600-s01e01" } })).EnsureSuccessStatusCode();
        var next = (await OkAsync(viewer, $"{Base}/series/600")).GetProperty("watch").GetProperty("nextEpisode");
        Assert.Equal(("tmdb-tv-600-s01e02", "next"), (next.GetProperty("workId").GetString(), next.GetProperty("reason").GetString()));

        (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "progress", workId = "tmdb-tv-600-s01e02", positionTicks = ViewerApi.Ticks(15), durationTicks = ViewerApi.Ticks(46),
        })).EnsureSuccessStatusCode();
        var resumed = await OkAsync(viewer, $"{Base}/series/600");
        var watch = resumed.GetProperty("watch");
        Assert.Equal(("tmdb-tv-600-s01e02", "resume"), (watch.GetProperty("nextEpisode").GetProperty("workId").GetString(), watch.GetProperty("nextEpisode").GetProperty("reason").GetString()));
        Assert.Equal(ViewerApi.Ticks(15), watch.GetProperty("nextEpisode").GetProperty("positionTicks").GetInt64());
        Assert.Equal((1, 1, 5), (watch.GetProperty("playedEpisodes").GetInt32(), watch.GetProperty("inProgressEpisodes").GetInt32(), watch.GetProperty("totalEpisodes").GetInt32()));
        var seasonOne = resumed.GetProperty("seasons")[1];
        Assert.Equal((1, 1), (seasonOne.GetProperty("playedCount").GetInt32(), seasonOne.GetProperty("inProgressCount").GetInt32()));
    }

    [Fact]
    public async Task Season_ListsEpisodesWithWatchState_WithoutIndexerSearch()
    {
        using var viewer = await ViewerAsync("season");
        (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/played", new { workIds = new[] { "tmdb-tv-600-s02e01" } })).EnsureSuccessStatusCode();
        var searches = factory.Newznab.Searches;

        var season = await OkAsync(viewer, $"{Base}/series/600/seasons/2");

        Assert.Equal(("tmdb-tv-600", "tmdb-tv-600-s02", "Catalog Show"), (season.GetProperty("seriesWorkId").GetString(), season.GetProperty("workId").GetString(), season.GetProperty("seriesTitle").GetString()));
        var episodes = season.GetProperty("episodes");
        Assert.Equal(2, episodes.GetArrayLength());
        Assert.True(episodes[0].GetProperty("aired").GetBoolean());
        Assert.False(episodes[1].GetProperty("aired").GetBoolean());
        Assert.True(episodes[0].GetProperty("watch").GetProperty("played").GetBoolean());
        Assert.False(episodes[1].GetProperty("watch").GetProperty("played").GetBoolean());
        Assert.Equal(45, episodes[1].GetProperty("runtimeMinutes").GetInt32());
        Assert.Equal(JsonValueKind.Null, episodes[0].GetProperty("versionCount").ValueKind);
        Assert.Equal(JsonValueKind.Null, season.GetProperty("availability").ValueKind);
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task SeasonAvailability_OverlaysVersionCounts_AndSharesTheCacheWithEpisodeVersions()
    {
        using var viewer = await ViewerAsync("avail");
        factory.Clock.Advance(IndexerCacheLifetime);
        var searches = factory.Newznab.Searches;

        var season = await OkAsync(viewer, $"{Base}/series/600/seasons/1?availability=true&refresh=true");
        var episode = await OkAsync(viewer, $"{Base}/works/tmdb-tv-600-s01e03/versions");

        Assert.Equal([3, 2, 1], season.GetProperty("episodes").EnumerateArray().Select(e => e.GetProperty("versionCount").GetInt32()));
        Assert.False(season.GetProperty("availability").GetProperty("fromCache").GetBoolean());
        Assert.Equal(JsonValueKind.Null, season.GetProperty("availability").GetProperty("error").ValueKind);
        Assert.Equal(searches + 1, factory.Newznab.Searches);
        Assert.True(episode.GetProperty("fromCache").GetBoolean());
        Assert.Equal("episode", episode.GetProperty("mediaType").GetString());
        var pack = Assert.Single(episode.GetProperty("versions").EnumerateArray());
        Assert.True(pack.GetProperty("seasonPack").GetBoolean());
        Assert.Equal("Catalog.Show.S01.1080p.BluRay.DD5.1.x264-PACK", pack.GetProperty("name").GetString());
        Assert.Equal(9_000_000_000L, pack.GetProperty("sizeBytes").GetInt64());
        // 9 GB over three episodes of the 45-minute series runtime (E03 has none of its own).
        Assert.Equal(9_000_000_000L / 3 * 8 / (45 * 60) / 1000, pack.GetProperty("estimatedBitrateKbps").GetInt64());
    }

    [Fact]
    public async Task ListItems_CarryTheSpecOfTheBestKnownVersion_AndPaletteFields()
    {
        using var viewer = await ViewerAsync("spec");

        await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions");
        var season = await OkAsync(viewer, $"{Base}/series/600/seasons/1?availability=true");
        var search = await OkAsync(viewer, $"{Base}/search?q=catalog");

        var items = search.GetProperty("items").EnumerateArray().ToDictionary(i => i.GetProperty("tmdbId").GetInt32());
        Assert.Equal(("4K", "DV", "HEVC", "Atmos"), Spec(items[501]));
        Assert.Equal(("1080p", null, "H.264", "5.1"), Spec(items[600]));
        Assert.Equal(("1080p", null, "H.264", "5.1"), Spec(season.GetProperty("episodes")[2]));
        foreach (var item in items.Values)
            Assert.Equal((JsonValueKind.Null, JsonValueKind.Null, JsonValueKind.Null),
                (item.GetProperty("tint").ValueKind, item.GetProperty("tint2").ValueKind, item.GetProperty("highlight").ValueKind));
        Assert.Equal(JsonValueKind.Null, season.GetProperty("tint").ValueKind);
    }

    private static (string?, string?, string?, string?) Spec(JsonElement item)
    {
        var spec = item.GetProperty("spec");
        return (spec.GetProperty("resolution").GetString(), spec.GetProperty("hdr").GetString(),
            spec.GetProperty("videoCodec").GetString(), spec.GetProperty("audio").GetString());
    }

    [Fact]
    public async Task MovieVersions_AreRankedParsedAndCached_UntilRefreshed()
    {
        using var viewer = await ViewerAsync("versions");
        factory.Clock.Advance(IndexerCacheLifetime);
        var searches = factory.Newznab.Searches;

        var first = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?refresh=true");
        var second = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions");
        factory.Clock.Advance(TimeSpan.FromSeconds(90));
        var afterIndexerCache = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions");
        var searchesBeforeRefresh = factory.Newznab.Searches;
        var refreshed = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?refresh=true");

        Assert.Equal(searches + 1, searchesBeforeRefresh);
        Assert.Equal(searchesBeforeRefresh + 1, factory.Newznab.Searches);
        Assert.False(first.GetProperty("fromCache").GetBoolean());
        Assert.True(second.GetProperty("fromCache").GetBoolean());
        Assert.True(afterIndexerCache.GetProperty("fromCache").GetBoolean());
        Assert.False(refreshed.GetProperty("fromCache").GetBoolean());
        Assert.True(refreshed.GetProperty("checkedAt").GetDateTimeOffset() > first.GetProperty("checkedAt").GetDateTimeOffset());
        Assert.False(first.GetProperty("incomplete").GetBoolean());

        var versions = first.GetProperty("versions").EnumerateArray().ToList();
        Assert.Equal(CatalogNewznabFake.MovieReleases.Order(), versions.Select(v => v.GetProperty("name").GetString()).Order());
        Assert.Equal([1, 2, 3, 4], versions.Select(v => v.GetProperty("rank").GetInt32()));
        Assert.Equal([true, false, false, false], versions.Select(v => v.GetProperty("recommended").GetBoolean()));
        var uhd = versions.Single(v => v.GetProperty("resolution").GetString() == "2160p");
        Assert.Equal("BluRay", uhd.GetProperty("source").GetString());
        Assert.Equal("hevc", uhd.GetProperty("videoCodec").GetString());
        Assert.Equal(10, uhd.GetProperty("bitDepth").GetInt32());
        Assert.Equal("dolbyvision", uhd.GetProperty("hdr").GetString());
        Assert.Equal(["dolbyvision", "hdr10"], uhd.GetProperty("hdrFormats").EnumerateArray().Select(f => f.GetString()));
        Assert.Equal(("truehd", "7.1", true), (uhd.GetProperty("audioCodec").GetString(), uhd.GetProperty("audioChannels").GetString(), uhd.GetProperty("atmos").GetBoolean()));
        Assert.Equal("GRP", uhd.GetProperty("releaseGroup").GetString());
        Assert.Equal(40_000_000_000L, uhd.GetProperty("sizeBytes").GetInt64());
        Assert.Equal(40_000_000_000L * 8 / (120 * 60) / 1000, uhd.GetProperty("estimatedBitrateKbps").GetInt64());
        Assert.Equal(3, uhd.GetProperty("ageDays").GetInt32());
        Assert.Equal("unknown", uhd.GetProperty("health").GetString());
        Assert.Equal(JsonValueKind.Null, uhd.GetProperty("local").ValueKind);
        Assert.Equal(JsonValueKind.Null, uhd.GetProperty("predictedMethod").ValueKind);
        var web = versions.Single(v => v.GetProperty("name").GetString() == CatalogNewznabFake.MovieReleases[1]);
        Assert.Equal(("h264", "eac3", "5.1"), (web.GetProperty("videoCodec").GetString(), web.GetProperty("audioCodec").GetString(), web.GetProperty("audioChannels").GetString()));
        Assert.Equal(JsonValueKind.Null, web.GetProperty("bitDepth").ValueKind);
        Assert.Equal(JsonValueKind.Null, web.GetProperty("hdr").ValueKind);
    }

    [Fact]
    public async Task VersionRefreshes_AreCoalesced_ForAMinute()
    {
        using var viewer = await ViewerAsync("refreshloop");
        factory.Clock.Advance(IndexerCacheLifetime);

        var first = await OkAsync(viewer, $"{Base}/works/tmdb-movie-502/versions?refresh=true");
        var looped = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => OkAsync(viewer, $"{Base}/works/tmdb-movie-502/versions?refresh=true")));
        factory.Clock.Advance(ViewerVersionCacheMinRefreshAge + TimeSpan.FromSeconds(1));
        var later = await OkAsync(viewer, $"{Base}/works/tmdb-movie-502/versions?refresh=true");

        Assert.False(first.GetProperty("fromCache").GetBoolean());
        Assert.All(looped, body =>
        {
            Assert.True(body.GetProperty("fromCache").GetBoolean());
            Assert.Equal(first.GetProperty("checkedAt").GetDateTimeOffset(), body.GetProperty("checkedAt").GetDateTimeOffset());
        });
        Assert.False(later.GetProperty("fromCache").GetBoolean());
        Assert.True(later.GetProperty("checkedAt").GetDateTimeOffset() > first.GetProperty("checkedAt").GetDateTimeOffset());
    }

    private static readonly TimeSpan ViewerVersionCacheMinRefreshAge = TimeSpan.FromSeconds(60);

    [Fact]
    public async Task Versions_NeverExposeIndexerOrNzbData()
    {
        using var viewer = await ViewerAsync("leak");

        var movie = await viewer.GetStringAsync($"{Base}/works/tmdb-movie-501/versions");
        var episode = await viewer.GetStringAsync($"{Base}/works/tmdb-tv-600-s01e01/versions");
        var season = await viewer.GetStringAsync($"{Base}/series/600/seasons/1?availability=true");

        foreach (var body in new[] { movie, episode, season })
        {
            foreach (var secret in new[] { CatalogNewznabFake.NzbHost, ".nzb", ViewerCatalogFactory.IndexerName, ViewerCatalogFactory.IndexerKey, "\"indexer", "\"score\"", "\"grabs\"", "guid-" })
                Assert.DoesNotContain(secret, body, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Versions_PredictThePlaybackMethod_ForASentDeviceProfile()
    {
        using var viewer = await ViewerAsync("predict", new { allowTranscoding = false });
        const string profile = "videoCodecs=h264,hevc&audioCodecs=aac,ac3,eac3&containers=mp4&hdrFormats=hdr10&supports10Bit=true&maxAudioChannels=6";

        var body = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?{profile}");
        var byName = body.GetProperty("versions").EnumerateArray().ToDictionary(v => v.GetProperty("name").GetString()!);

        string Method(int index) => byName[CatalogNewznabFake.MovieReleases[index]].GetProperty("predictedMethod").GetString()!;
        string[] Codes(int index) => byName[CatalogNewznabFake.MovieReleases[index]].GetProperty("predictionReasons").EnumerateArray()
            .Select(r => r.GetProperty("code").GetString()!).ToArray();
        Assert.Equal("remux", Method(0));
        Assert.Contains("container_assumed", Codes(0));
        Assert.Contains("audio_converted", Codes(0));
        Assert.Equal("remux", Method(1));
        Assert.Equal("direct", Method(2));
        Assert.DoesNotContain("container_assumed", Codes(2));
        Assert.Equal("transcode", Method(3));
        Assert.Contains("video_codec_unsupported", Codes(3));
        Assert.Contains("transcoding_not_allowed", Codes(3));
    }

    [Fact]
    public async Task Versions_PredictHdrAsTenBit_WhenTheProfileListsHdrFormatsWithoutSupports10Bit()
    {
        using var viewer = await ViewerAsync("predicthdr", new { allowTranscoding = false });

        var body = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?videoCodecs=h264,hevc&audioCodecs=aac,ac3,eac3&containers=mp4&hdrFormats=hdr10&maxAudioChannels=6");
        var uhd = body.GetProperty("versions").EnumerateArray().Single(v => v.GetProperty("name").GetString() == CatalogNewznabFake.MovieReleases[0]);

        Assert.Equal("remux", uhd.GetProperty("predictedMethod").GetString());
        Assert.DoesNotContain("bit_depth_unsupported", uhd.GetProperty("predictionReasons").EnumerateArray().Select(r => r.GetProperty("code").GetString()));
    }

    [Fact]
    public async Task Versions_RespectTheSentVlcEngineCaps_InThePrediction()
    {
        using var viewer = await ViewerAsync("predictvlc");
        const string profile = "videoCodecs=h264&audioCodecs=aac&containers=mp4&vlcAvailable=true";
        string Av1(JsonElement body) => body.GetProperty("versions").EnumerateArray()
            .Single(v => v.GetProperty("name").GetString() == CatalogNewznabFake.MovieReleases[3]).GetProperty("predictedMethod").GetString()!;

        var anyVlc = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?{profile}");
        var noAv1 = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?{profile}&vlcVideoCodecs=h264,hevc:1080");
        var capped = await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?{profile}&vlcMaxHeight=720");

        Assert.Equal("vlc", Av1(anyVlc));
        Assert.Equal("transcode", Av1(noAv1));
        Assert.Equal("transcode", Av1(capped));
        var vlcReasons = anyVlc.GetProperty("versions").EnumerateArray()
            .Single(v => v.GetProperty("name").GetString() == CatalogNewznabFake.MovieReleases[3]).GetProperty("predictionReasons")
            .EnumerateArray().Select(r => r.GetProperty("code").GetString()).ToList();
        Assert.Contains("vlc_fallback", vlcReasons);
        Assert.Contains("direct_play", vlcReasons);
        Assert.DoesNotContain("video_codec_unsupported", vlcReasons);
    }

    [Theory]
    [InlineData("vlcMaxHeight=99")]
    [InlineData("vlcVideoCodecs=hevc:big")]
    [InlineData("vlcVideoCodecs=hevc:9000")]
    [InlineData("vlcVideoCodecs=h264,h266")]
    [InlineData("vlcVideoCodecs=prores:1080")]
    [InlineData("vlcHdrFormats=none,hdr10")]
    public async Task Versions_RejectInvalidVlcCaps(string query)
    {
        using var viewer = await ViewerAsync("badvlc");

        var error = await ErrorAsync(viewer, $"{Base}/works/tmdb-movie-501/versions?videoCodecs=h264&vlcAvailable=true&{query}", HttpStatusCode.BadRequest);

        Assert.Equal("invalid_device_profile", error.GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("tmdb-tv-600")]
    [InlineData("tmdb-tv-600-s01")]
    [InlineData("not-a-work")]
    [InlineData("unmatched-movie-some-title")]
    public async Task Versions_NeedAMovieOrEpisodeId(string workId)
    {
        using var viewer = await ViewerAsync("badwork");

        var error = await ErrorAsync(viewer, $"{Base}/works/{workId}/versions", HttpStatusCode.BadRequest);

        Assert.Equal("invalid_work_id", error.GetProperty("code").GetString());
    }

    [Fact]
    public async Task FailingIndexers_Answer503ForVersions_AndMarkTheSeasonOverlay()
    {
        using var viewer = await ViewerAsync("broken");

        var versions = await viewer.GetAsync($"{Base}/works/tmdb-movie-505/versions");
        var season = await OkAsync(viewer, $"{Base}/series/602/seasons/1?availability=true");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, versions.StatusCode);
        Assert.Equal("search_temporarily_unavailable", await ViewerApi.ErrorCodeAsync(versions));
        Assert.Equal("1", versions.Headers.RetryAfter?.ToString());
        Assert.Equal("search_temporarily_unavailable", season.GetProperty("availability").GetProperty("error").GetString());
        Assert.All(season.GetProperty("episodes").EnumerateArray(), e => Assert.Equal(JsonValueKind.Null, e.GetProperty("versionCount").ValueKind));
    }

    [Fact]
    public async Task AdminMachineAndAnonymousCredentials_AreRejected()
    {
        using var machine = factory.Bearer(ViewerCatalogFactory.ApiKey);
        using var anon = factory.CreateClient();
        var searches = factory.Newznab.Searches;

        foreach (var path in new[]
                 {
                     $"{Base}/search?q=movie", $"{Base}/discover", $"{Base}/movies/501", $"{Base}/series/600",
                     $"{Base}/series/600/seasons/1", $"{Base}/works/tmdb-movie-501/versions",
                 })
        {
            foreach (var client in new[] { _admin, machine, anon })
            {
                var response = await client.GetAsync(path);
                Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
                Assert.Equal("unauthorized", await ViewerApi.ErrorCodeAsync(response));
            }
        }
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task PendingPasswordChange_BlocksTheCatalog()
    {
        using var viewer = await ViewerAsync("pwchange", mustChangePassword: true);

        foreach (var path in new[] { $"{Base}/discover", $"{Base}/movies/501", $"{Base}/works/tmdb-movie-501/versions" })
            Assert.Equal("password_change_required", (await ErrorAsync(viewer, path, HttpStatusCode.Forbidden)).GetProperty("code").GetString());
    }

    private static async Task ReportAsync(HttpClient viewer, string workId, double percent, string playbackId)
    {
        var duration = ViewerApi.Ticks(45 * 60);
        (await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "progress", workId, positionTicks = (long)(duration * percent / 100), durationTicks = duration, playbackId,
        })).EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement?> NextUpAsync(HttpClient viewer, string seriesWorkId)
        => (await OkAsync(viewer, $"/api/v1/viewer/watch/next-up?seriesWorkId={seriesWorkId}")).GetProperty("items").EnumerateArray()
            .Select(i => (JsonElement?)i).FirstOrDefault();

    private static async Task<string[]> ContinueAsync(HttpClient viewer)
        => (await OkAsync(viewer, "/api/v1/viewer/watch/resume")).EnumerateArray().Select(i => i.GetProperty("workId").GetString()!).ToArray();

    [Fact]
    public async Task ActiveReplay_OfAWatchedEpisode_IsTheSeriesCurrentEpisode_OnEverySurface()
    {
        using var viewer = await ViewerAsync("replay");
        foreach (var episode in new[] { "s01e01", "s01e02", "s01e03" })
        {
            await ReportAsync(viewer, $"tmdb-tv-600-{episode}", 100, $"pb-{episode}");
            factory.Clock.Advance(TimeSpan.FromMinutes(1));
        }
        await ReportAsync(viewer, "tmdb-tv-600-s01e02", 2, "pb-replay");
        await ReportAsync(viewer, "tmdb-tv-600-s01e02", 20, "pb-replay");

        var next = (await NextUpAsync(viewer, "tmdb-tv-600"))!.Value;
        Assert.Equal("tmdb-tv-600-s01e02", next.GetProperty("workId").GetString());
        Assert.True(next.GetProperty("positionTicks").GetInt64() > 0);
        Assert.Equal("tmdb-tv-600-s01e02", next.GetProperty("lastWatchedWorkId").GetString());
        Assert.Equal("Episode 2", next.GetProperty("episodeTitle").GetString());
        var series = (await OkAsync(viewer, $"{Base}/series/600")).GetProperty("watch").GetProperty("nextEpisode");
        Assert.Equal(("tmdb-tv-600-s01e02", "resume"), (series.GetProperty("workId").GetString(), series.GetProperty("reason").GetString()));
        Assert.Equal(["tmdb-tv-600-s01e02"], await ContinueAsync(viewer));

        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await ReportAsync(viewer, "tmdb-tv-600-s01e03", 100, "pb-again");

        Assert.Equal("tmdb-tv-600-s02e01", (await NextUpAsync(viewer, "tmdb-tv-600"))!.Value.GetProperty("workId").GetString());
        series = (await OkAsync(viewer, $"{Base}/series/600")).GetProperty("watch").GetProperty("nextEpisode");
        Assert.Equal(("tmdb-tv-600-s02e01", "next"), (series.GetProperty("workId").GetString(), series.GetProperty("reason").GetString()));
        Assert.Empty(await ContinueAsync(viewer));
    }

    [Fact]
    public async Task NextEpisode_WithoutAnyVersion_StaysInOrder_WithAvailableFalse()
    {
        using var viewer = await ViewerAsync("available");
        await ReportAsync(viewer, "tmdb-tv-601-s01e01", 100, "pb-adult-1");
        await ReportAsync(viewer, "tmdb-tv-600-s01e01", 100, "pb-show-1");

        var before = (await NextUpAsync(viewer, "tmdb-tv-601"))!.Value;
        Assert.Equal("tmdb-tv-601-s01e02", before.GetProperty("workId").GetString());
        Assert.True(before.GetProperty("available").GetBoolean());

        await OkAsync(viewer, $"{Base}/series/601/seasons/1?availability=true");
        await OkAsync(viewer, $"{Base}/series/600/seasons/1?availability=true");

        var after = (await NextUpAsync(viewer, "tmdb-tv-601"))!.Value;
        Assert.Equal(("tmdb-tv-601-s01e02", false), (after.GetProperty("workId").GetString(), after.GetProperty("available").GetBoolean()));
        var available = (await NextUpAsync(viewer, "tmdb-tv-600"))!.Value;
        Assert.Equal(("tmdb-tv-600-s01e02", true), (available.GetProperty("workId").GetString(), available.GetProperty("available").GetBoolean()));
        var series = (await OkAsync(viewer, $"{Base}/series/601")).GetProperty("watch").GetProperty("nextEpisode");
        Assert.Equal(("tmdb-tv-601-s01e02", false), (series.GetProperty("workId").GetString(), series.GetProperty("available").GetBoolean()));

        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await ReportAsync(viewer, "tmdb-tv-601-s01e02", 30, "pb-adult-2");
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await ReportAsync(viewer, "tmdb-tv-600-s01e02", 30, "pb-show-2");
        var resume = (await OkAsync(viewer, "/api/v1/viewer/watch/resume")).EnumerateArray()
            .ToDictionary(i => i.GetProperty("workId").GetString()!, i => i.GetProperty("available").GetBoolean());
        Assert.Equal(new Dictionary<string, bool> { ["tmdb-tv-600-s01e02"] = true, ["tmdb-tv-601-s01e02"] = false }, resume);
        var history = (await OkAsync(viewer, "/api/v1/viewer/watch/history")).GetProperty("items")[0];
        Assert.True(!history.TryGetProperty("available", out var none) || none.ValueKind == JsonValueKind.Null);
    }
}

/// <summary>Health overlay on its own host: a dead mark outlives the test and would change other tests' lists.</summary>
public sealed class ViewerCatalogHealthTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>
{
    private const string Base = "/api/v1/viewer/catalog";

    private async Task<HttpClient> ViewerAsync(string name)
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        await ViewerApi.CreateAsync(admin, new { username = name, password = "correct horse battery" });
        using var anon = factory.CreateClient();
        return factory.Bearer(await ViewerApi.AccessTokenAsync(anon, name, "correct horse battery"));
    }

    private static async Task<JsonElement> OkAsync(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Versions_OverlayCurrentHealth_DroppingKnownDeadReleases()
    {
        using var viewer = await ViewerAsync("health");
        var before = (await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions")).GetProperty("versions").EnumerateArray().ToList();
        var health = factory.Services.GetRequiredService<IReleaseHealthCache>();
        var best = before[0].GetProperty("releaseId").GetString()!;
        var degraded = before[1].GetProperty("releaseId").GetString()!;

        health.Record(best, ReleaseHealth.Dead);
        health.Record(degraded, ReleaseHealth.Degraded);
        var after = (await OkAsync(viewer, $"{Base}/works/tmdb-movie-501/versions")).GetProperty("versions").EnumerateArray().ToList();

        Assert.Equal(before.Count - 1, after.Count);
        Assert.DoesNotContain(after, v => v.GetProperty("releaseId").GetString() == best);
        Assert.Equal((degraded, 1, true, "degraded"), (after[0].GetProperty("releaseId").GetString(), after[0].GetProperty("rank").GetInt32(),
            after[0].GetProperty("recommended").GetBoolean(), after[0].GetProperty("health").GetString()));
    }

}

/// <summary>Catalog endpoints vanish with the module; its own host so switching the module off cannot race other tests.</summary>
public sealed class ViewerCatalogModuleGateTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>
{
    [Fact]
    public async Task DisabledModule_Answers404ModuleDisabled()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.CreateAsync(admin, new { username = "gate-catalog", password = "correct horse battery" });
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, "gate-catalog", "correct horse battery"));
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/catalog/discover")).StatusCode);

        await ViewerApi.ConfigureAsync(admin, new { enabled = false });
        foreach (var path in new[] { "discover", "search?q=movie", "movies/501", "series/600", "series/600/seasons/1", "works/tmdb-movie-501/versions" })
        {
            var response = await viewer.GetAsync($"/api/v1/viewer/catalog/{path}");
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("module_disabled", await ViewerApi.ErrorCodeAsync(response));
        }
        Assert.Equal(0, factory.Newznab.Searches);
    }
}
