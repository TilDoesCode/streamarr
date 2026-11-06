using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Download candidates, season packs and the similarity plan over the real catalog ranking with fake indexers.</summary>
public sealed class DownloadCandidatesTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>, IAsyncLifetime
{
    private const string Candidates = "/api/v1/viewer/downloads/candidates";
    private const string Movie = "tmdb-movie-501";
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

    private static JsonElement ByName(JsonElement candidates, string fragment)
        => candidates.EnumerateArray().Single(c => c.GetProperty("version").GetProperty("name").GetString()!.Contains(fragment, StringComparison.Ordinal));

    private static string[] Codes(JsonElement candidate)
        => candidate.GetProperty("offline").GetProperty("reasons").EnumerateArray().Select(r => r.GetProperty("code").GetString()!).ToArray();

    [Fact]
    public async Task AndroidTv_OffersTheFilesItsPlayerPlaysAsTheyAre_FirstAndRecommended()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-tv");

        var body = await Dl.PostAsync(viewer, Candidates, new { workId = Movie, device = Dl.AndroidTv });
        var candidates = body.GetProperty("candidates");

        Assert.Equal("movie", body.GetProperty("mediaType").GetString());
        Assert.Equal(2, body.GetProperty("streamOnlyCount").GetInt32());
        var first = candidates[0];
        Assert.True(first.GetProperty("offline").GetProperty("playable").GetBoolean());
        Assert.True(first.GetProperty("recommended").GetBoolean());
        Assert.Equal(1, first.GetProperty("version").GetProperty("rank").GetInt32());
        Assert.Equal("native", first.GetProperty("offline").GetProperty("engine").GetString());
        var playable = candidates.EnumerateArray().TakeWhile(c => c.GetProperty("offline").GetProperty("playable").GetBoolean()).Count();
        Assert.Equal(2, playable);
        Assert.Single(candidates.EnumerateArray(), c => c.GetProperty("recommended").GetBoolean());

        var av1 = ByName(candidates, "AV1");
        Assert.False(av1.GetProperty("offline").GetProperty("playable").GetBoolean());
        Assert.Contains("video_codec_unsupported", Codes(av1));
        Assert.Contains("vlc_unavailable", Codes(av1));
        Assert.Equal("transcode", av1.GetProperty("offline").GetProperty("streamingMethod").GetString());
        var uhd = ByName(candidates, "2160p");
        Assert.False(uhd.GetProperty("offline").GetProperty("playable").GetBoolean());
        Assert.Contains("audio_codec_unsupported", Codes(uhd));

        var web = ByName(candidates, "1080p.WEB-DL.DDP5.1");
        Assert.Equal(8_000_000_000, web.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("indexer", web.GetProperty("sizeSource").GetString());
        Assert.False(web.GetProperty("sizeExact").GetBoolean());
        Assert.False(web.GetProperty("seasonPack").GetBoolean());
        Assert.Equal(JsonValueKind.Null, web.GetProperty("packEpisodes").ValueKind);
        Assert.Contains("container_assumed", Codes(web));
    }

    [Fact]
    public async Task IPhone_PlaysMkvWithVlc_AndMp4Natively_NativeFirst()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-ios");

        var candidates = (await Dl.PostAsync(viewer, Candidates, new { workId = Movie, device = Dl.IPhone })).GetProperty("candidates");

        var mp4 = ByName(candidates, "720p");
        Assert.Equal("native", mp4.GetProperty("offline").GetProperty("engine").GetString());
        var mkv = ByName(candidates, "1080p.WEB-DL.DDP5.1");
        Assert.True(mkv.GetProperty("offline").GetProperty("playable").GetBoolean());
        Assert.Equal("vlc", mkv.GetProperty("offline").GetProperty("engine").GetString());
        Assert.Contains("vlc_fallback", Codes(mkv));
        Assert.Equal("remux", mkv.GetProperty("offline").GetProperty("streamingMethod").GetString());
        Assert.Equal("vlc", ByName(candidates, "AV1").GetProperty("offline").GetProperty("engine").GetString());
    }

    [Fact]
    public async Task WithoutVlc_AnIPhoneCanOnlyDownloadTheMp4_AndSaysWhyNotTheRest()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-novlc");

        var body = await Dl.PostAsync(viewer, Candidates, new { workId = Movie, device = Dl.IPhoneNoVlc });
        var candidates = body.GetProperty("candidates");

        Assert.Equal(3, body.GetProperty("streamOnlyCount").GetInt32());
        Assert.Contains("720p", candidates[0].GetProperty("version").GetProperty("name").GetString());
        Assert.True(candidates[0].GetProperty("recommended").GetBoolean());
        var mkv = ByName(candidates, "1080p.WEB-DL.DDP5.1");
        Assert.Contains("container_unsupported", Codes(mkv));
        Assert.False(mkv.GetProperty("recommended").GetBoolean());
    }

    [Fact]
    public async Task AnEarlierResolveOfTheFile_MakesTheSizeExact()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-size");
        const string language = "tmdb-movie-506";
        var first = await Dl.PostAsync(viewer, Candidates, new { workId = language, device = Dl.AndroidTv });
        var german = ByName(first.GetProperty("candidates"), "German");
        Assert.Equal("indexer", german.GetProperty("sizeSource").GetString());
        var releaseId = german.GetProperty("version").GetProperty("releaseId").GetString()!;

        factory.ResolvedFiles.Record(releaseId, language, "Language.Movie.mkv", 7_654_321_000, "mkv");
        var again = ByName((await Dl.PostAsync(viewer, Candidates, new { workId = language, device = Dl.AndroidTv })).GetProperty("candidates"), "German");

        Assert.Equal(7_654_321_000, again.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("resolved", again.GetProperty("sizeSource").GetString());
        Assert.True(again.GetProperty("sizeExact").GetBoolean());
    }

    [Fact]
    public async Task AnEpisodeInAPack_HasAnEstimatedShare_AndTheEpisodesItCovers()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-ep");

        var candidates = (await Dl.PostAsync(viewer, Candidates, new { workId = "tmdb-tv-600-s01e02", device = Dl.AndroidTv })).GetProperty("candidates");

        var pack = ByName(candidates, "S01.1080p.BluRay");
        Assert.True(pack.GetProperty("seasonPack").GetBoolean());
        Assert.Equal([1, 2, 3], pack.GetProperty("packEpisodes").EnumerateArray().Select(e => e.GetInt32()).ToArray());
        Assert.Equal(3_000_000_000, pack.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("estimate", pack.GetProperty("sizeSource").GetString());
        var single = ByName(candidates, "S01E02");
        Assert.False(single.GetProperty("seasonPack").GetBoolean());
        Assert.Equal(2_100_000_000, single.GetProperty("sizeBytes").GetInt64());
    }

    [Fact]
    public async Task Season_ListsItsPacks_WithCoverageAndSizes_AndEveryEpisode()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-season");

        var body = await Dl.PostAsync(viewer, $"{Candidates}/season", new { workId = "tmdb-tv-600-s01", device = Dl.AndroidTv });

        Assert.Equal("tmdb-tv-600", body.GetProperty("seriesWorkId").GetString());
        var pack = Assert.Single(body.GetProperty("packs").EnumerateArray());
        Assert.Contains("S01.1080p.BluRay", pack.GetProperty("version").GetProperty("name").GetString());
        Assert.Equal([1, 2, 3], pack.GetProperty("episodes").EnumerateArray().Select(e => e.GetInt32()).ToArray());
        Assert.True(pack.GetProperty("complete").GetBoolean());
        Assert.Equal(9_000_000_000, pack.GetProperty("packSizeBytes").GetInt64());
        Assert.Equal(3_000_000_000, pack.GetProperty("perEpisodeSizeBytes").GetInt64());
        Assert.Equal(9_000_000_000, pack.GetProperty("sizeBytes").GetInt64());
        Assert.False(pack.GetProperty("sizeExact").GetBoolean());
        Assert.True(pack.GetProperty("offline").GetProperty("playable").GetBoolean());
        Assert.True(pack.GetProperty("recommended").GetBoolean());

        var episodes = body.GetProperty("episodes").EnumerateArray().ToList();
        Assert.Equal([1, 2, 3], episodes.Select(e => e.GetProperty("episodeNumber").GetInt32()).ToArray());
        Assert.All(episodes, e => Assert.NotEmpty(e.GetProperty("candidates").EnumerateArray()));
        Assert.Equal(3, episodes[0].GetProperty("candidates").GetArrayLength());

        var packsOnly = await Dl.PostAsync(viewer, $"{Candidates}/season", new { workId = "tmdb-tv-600-s01", device = Dl.AndroidTv, includeEpisodes = false });
        Assert.All(packsOnly.GetProperty("episodes").EnumerateArray(), e => Assert.Empty(e.GetProperty("candidates").EnumerateArray()));
    }

    [Fact]
    public async Task Season_LeavesUnairedEpisodesWithoutCandidates()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-unaired");

        var body = await Dl.PostAsync(viewer, $"{Candidates}/season", new { workId = "tmdb-tv-600-s02", device = Dl.AndroidTv });

        var episodes = body.GetProperty("episodes").EnumerateArray().ToList();
        Assert.True(episodes[0].GetProperty("aired").GetBoolean());
        Assert.NotEmpty(episodes[0].GetProperty("candidates").EnumerateArray());
        Assert.False(episodes[1].GetProperty("aired").GetBoolean());
        Assert.Empty(episodes[1].GetProperty("candidates").EnumerateArray());
        Assert.Empty(body.GetProperty("packs").EnumerateArray());
    }

    [Fact]
    public async Task Season_MergesPackCopies_AndRanksTheDownloadablePacksFirst()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-packs");

        var packs = (await Dl.PostAsync(viewer, $"{Candidates}/season", new { workId = "tmdb-tv-604-s01", device = Dl.IPhoneNoVlc }))
            .GetProperty("packs").EnumerateArray().ToList();

        Assert.Equal(3, packs.Count);
        Assert.Equal(packs.Count, packs.Select(p => p.GetProperty("version").GetProperty("name").GetString()).Distinct().Count());
        Assert.All(packs, p => Assert.False(p.GetProperty("offline").GetProperty("playable").GetBoolean()));
        Assert.DoesNotContain(packs, p => p.GetProperty("recommended").GetBoolean());
    }

    [Fact]
    public async Task Plan_TakesTheAnchorsGroup_ForTheNextEpisode()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "plan-group");
        var anchor = ByName((await Dl.PostAsync(viewer, Candidates, new { workId = "tmdb-tv-603-s01e01", device = Dl.AndroidTv })).GetProperty("candidates"), "-ALPHA");

        var plan = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan", new
        {
            anchorWorkId = "tmdb-tv-603-s01e01",
            anchorReleaseId = anchor.GetProperty("version").GetProperty("releaseId").GetString(),
            workIds = new[] { "tmdb-tv-603-s01e01", "tmdb-tv-603-s01e02", "tmdb-tv-603-s01e03" },
            device = Dl.AndroidTv,
            audioLanguages = new[] { "en" },
        });

        var items = plan.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(["tmdb-tv-603-s01e01", "tmdb-tv-603-s01e02", "tmdb-tv-603-s01e03"], items.Select(i => i.GetProperty("workId").GetString()).ToArray());
        Assert.Equal("same_release", items[0].GetProperty("match").GetString());
        Assert.Equal(100, items[0].GetProperty("score").GetDouble());
        Assert.Equal("same_release", items[1].GetProperty("match").GetString());
        Assert.EndsWith("-ALPHA", items[1].GetProperty("candidate").GetProperty("version").GetProperty("name").GetString());
        Assert.Equal("none", items[2].GetProperty("match").GetString());
        Assert.Equal("no_versions", items[2].GetProperty("notes")[0].GetProperty("code").GetString());
        Assert.Equal(4_000_000_000, plan.GetProperty("totalSizeBytes").GetInt64());
    }

    [Fact]
    public async Task Plan_NeverPassesOverTheViewersLanguage_ForASimilarRelease()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "plan-lang");
        var anchor = ByName((await Dl.PostAsync(viewer, Candidates, new { workId = "tmdb-tv-603-s01e01", device = Dl.AndroidTv })).GetProperty("candidates"), "-ALPHA");

        var plan = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan", new
        {
            anchorWorkId = "tmdb-tv-603-s01e01",
            anchorReleaseId = anchor.GetProperty("version").GetProperty("releaseId").GetString(),
            workIds = new[] { "tmdb-tv-603-s01e02" },
            device = Dl.AndroidTv,
            audioLanguages = new[] { "de" },
        });

        var item = plan.GetProperty("items")[0];
        Assert.Equal("best_available", item.GetProperty("match").GetString());
        Assert.Contains("German", item.GetProperty("candidate").GetProperty("version").GetProperty("name").GetString());
        Assert.Equal("language_mismatch", item.GetProperty("notes")[0].GetProperty("code").GetString());
    }

    [Fact]
    public async Task Plan_RejectsEpisodesOfAnotherSeries_AndAnUnknownAnchor()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "plan-bad");

        var other = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan",
            new { anchorWorkId = "tmdb-tv-603-s01e01", anchorReleaseId = "x", workIds = new[] { "tmdb-tv-600-s01e01" }, device = Dl.AndroidTv }, 400);
        Assert.Equal("invalid_work_id", Dl.Code(other));
        var unknown = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan",
            new { anchorWorkId = "tmdb-tv-603-s01e01", anchorReleaseId = "rel-unknown", workIds = new[] { "tmdb-tv-603-s01e02" }, device = Dl.AndroidTv }, 404);
        Assert.Equal("release_not_found", Dl.Code(unknown));
    }

    [Fact]
    public async Task DownloadsTurnedOff_AnswerForbidden()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-off", new { allowDownloads = false });

        var body = await Dl.PostAsync(viewer, Candidates, new { workId = Movie, device = Dl.AndroidTv }, 403);

        Assert.Equal("downloads_not_allowed", Dl.Code(body));
    }

    [Fact]
    public async Task TheAgeGate_StillApplies()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-kid", new { maxAge = 12 });

        var body = await Dl.PostAsync(viewer, Candidates, new { workId = "tmdb-movie-502", device = Dl.AndroidTv }, 403);

        Assert.Equal("age_restricted", Dl.Code(body));
    }

    [Fact]
    public async Task BadRequests_UseTheErrorEnvelope()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "cand-400");

        Assert.Equal("invalid_work_id", Dl.Code(await Dl.PostAsync(viewer, Candidates, new { workId = "tmdb-tv-600", device = Dl.AndroidTv }, 400)));
        Assert.Equal("invalid_device_profile", Dl.Code(await Dl.PostAsync(viewer, Candidates, new { workId = Movie }, 400)));
        Assert.Equal("invalid_work_id", Dl.Code(await Dl.PostAsync(viewer, $"{Candidates}/season", new { workId = Movie, device = Dl.AndroidTv }, 400)));
        Assert.Equal("invalid_download_request", Dl.Code(await Dl.PostAsync(viewer, Candidates, new { workId = Movie, device = Dl.AndroidTv, engine = "mpv" }, 400)));
    }
}
