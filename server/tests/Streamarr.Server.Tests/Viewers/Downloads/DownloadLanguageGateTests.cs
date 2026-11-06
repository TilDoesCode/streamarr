using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>
/// Recommendations stay in the best audio language the viewer can get (V1-06); the similarity plan follows the language of the version the
/// viewer picked instead (fix round 1b), and only falls back to the viewer's language when nothing in the pick's language is downloadable.
/// </summary>
public sealed class DownloadLanguageGateTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>, IAsyncLifetime
{
    private const string Base = "/api/v1/viewer/downloads";
    private static readonly string Season = $"tmdb-tv-{CatalogTmdbFake.AffinityShow}-s0{ViewerDownloadFactory.LanguageSeason}";
    private static string Episode(int n) => $"{Season}e0{n}";
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

    private static string Name(JsonElement candidate) => candidate.GetProperty("version").GetProperty("name").GetString()!;

    private static readonly string FirstSeason = $"tmdb-tv-{CatalogTmdbFake.AffinityShow}-s01";

    private async Task<string> ReleaseAsync(HttpClient viewer, string workId, Func<string, bool> name)
        => (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId, device = Dl.AndroidTv })).GetProperty("candidates").EnumerateArray()
            .First(c => name(Name(c))).GetProperty("version").GetProperty("releaseId").GetString()!;

    private static Task<JsonElement> PlanAsync(HttpClient viewer, string anchorWorkId, string anchorReleaseId, string[] workIds, string[]? audioLanguages)
        => Dl.PostAsync(viewer, $"{Base}/plan", new { anchorWorkId, anchorReleaseId, workIds, device = Dl.AndroidTv, audioLanguages });

    private static string[] Codes(JsonElement item) => item.GetProperty("notes").EnumerateArray().Select(n => n.GetProperty("code").GetString()!).ToArray();

    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    [InlineData(null)]
    public async Task AnUntaggedPick_GetsItsOwnReleaseForTheNextEpisode_WhateverTheViewersLanguage(string? language)
    {
        // The DL-C2 Sherlock case: an untagged 720p WEB-DL next to German releases.
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-untagged");
        var anchor = await ReleaseAsync(viewer, $"{FirstSeason}e01", n => n.EndsWith("-ALPHA", StringComparison.Ordinal));

        var plan = await PlanAsync(viewer, $"{FirstSeason}e01", anchor, [$"{FirstSeason}e02"], language is null ? null : [language]);

        var item = plan.GetProperty("items")[0];
        Assert.Equal("same_release", item.GetProperty("match").GetString());
        Assert.Equal(100, item.GetProperty("score").GetDouble());
        Assert.EndsWith("-ALPHA", Name(item.GetProperty("candidate")), StringComparison.Ordinal);
        Assert.Empty(Codes(item));
    }

    [Fact]
    public async Task AGermanPick_PlansGerman_EvenForAnEnglishViewer_AndOverABetterPicture()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-german");
        var sameGroup = await ReleaseAsync(viewer, Episode(1), n => n.EndsWith("-GERMAN", StringComparison.Ordinal));
        var otherGroup = await ReleaseAsync(viewer, $"{FirstSeason}e02", n => n.EndsWith("-GAMMA", StringComparison.Ordinal));

        var same = (await PlanAsync(viewer, Episode(1), sameGroup, [Episode(2)], ["en"])).GetProperty("items")[0];
        var other = (await PlanAsync(viewer, $"{FirstSeason}e02", otherGroup, [Episode(2)], ["en"])).GetProperty("items")[0];

        // The episode's own release or the group's pack: both are the same release apart from the numbering.
        Assert.Equal("same_release", same.GetProperty("match").GetString());
        Assert.EndsWith(".German.720p.HDTV.AAC2.0.H.264-GERMAN", Name(same.GetProperty("candidate")), StringComparison.Ordinal);
        Assert.Equal("best_available", other.GetProperty("match").GetString());
        Assert.EndsWith(".German.720p.HDTV.AAC2.0.H.264-GERMAN", Name(other.GetProperty("candidate")), StringComparison.Ordinal);
        Assert.Empty(Codes(other));
    }

    [Fact]
    public async Task AnEnglishPick_PlansEnglish_EvenForAGermanViewer()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-english");
        var anchor = await ReleaseAsync(viewer, Episode(1), n => n.EndsWith("-ENGLISH", StringComparison.Ordinal));

        var item = (await PlanAsync(viewer, Episode(1), anchor, [Episode(2)], ["de"])).GetProperty("items")[0];

        Assert.Equal("same_release", item.GetProperty("match").GetString());
        Assert.EndsWith(".2160p.UHD.BluRay.DDP5.1.HDR10.x265-ENGLISH", Name(item.GetProperty("candidate")), StringComparison.Ordinal);
    }

    [Fact]
    public async Task NothingInThePicksLanguage_FallsBackToTheViewersLanguage_WithALanguageDiffersNote()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-differs");
        var anchor = await ReleaseAsync(viewer, $"{FirstSeason}e01", n => n.EndsWith("-ALPHA", StringComparison.Ordinal));

        var plan = await PlanAsync(viewer, $"{FirstSeason}e01", anchor, [Episode(1), Episode(2)], ["de"]);

        Assert.All(plan.GetProperty("items").EnumerateArray(), item =>
        {
            Assert.Equal("best_available", item.GetProperty("match").GetString());
            Assert.Contains("German", Name(item.GetProperty("candidate")), StringComparison.Ordinal);
            var note = item.GetProperty("notes").EnumerateArray().Single(n => n.GetProperty("code").GetString() == "language_differs");
            Assert.Equal("de", note.GetProperty("params").GetProperty("languages").GetString());
            Assert.Equal("untagged", note.GetProperty("params").GetProperty("anchorLanguages").GetString());
        });
    }

    [Theory]
    [InlineData(new string[0], new string[0], true)]
    [InlineData(new[] { "de" }, new[] { "de" }, true)]
    [InlineData(new[] { "de" }, new[] { "de", "en" }, true)]
    [InlineData(new string[0], new[] { "en" }, false)]
    [InlineData(new[] { "en" }, new string[0], false)]
    [InlineData(new[] { "de" }, new[] { "en", "de" }, false)]
    public void TheLanguageClass_IsThePrimaryLanguage_OrBothUntagged(string[] anchor, string[] candidate, bool same)
        => Assert.Equal(same, Streamarr.Server.Viewers.Catalog.ViewerCatalogService.SameLanguage(anchor, candidate));

    [Fact]
    public async Task TheRecommendedEpisodeDownload_IsInTheViewersLanguage()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-episode");

        var german = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Episode(1), device = Dl.AndroidTv, audioLanguages = new[] { "de" } }))
            .GetProperty("candidates");
        var english = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Episode(1), device = Dl.AndroidTv, audioLanguages = new[] { "en" } }))
            .GetProperty("candidates");

        var recommended = Assert.Single(german.EnumerateArray(), c => c.GetProperty("recommended").GetBoolean());
        Assert.Contains("German", Name(recommended), StringComparison.Ordinal);
        Assert.True(recommended.GetProperty("version").GetProperty("recommended").GetBoolean());
        Assert.Contains("ENGLISH", Name(Assert.Single(english.EnumerateArray(), c => c.GetProperty("recommended").GetBoolean())), StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheSeasonsRecommendedPackAndEpisodes_AreInTheViewersLanguage()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-season");

        var season = await Dl.PostAsync(viewer, $"{Base}/candidates/season", new { workId = Season, device = Dl.AndroidTv, audioLanguages = new[] { "de" } });

        var packs = season.GetProperty("packs");
        Assert.Equal(2, packs.GetArrayLength());
        var pack = Assert.Single(packs.EnumerateArray(), p => p.GetProperty("recommended").GetBoolean());
        Assert.Contains("German", Name(pack), StringComparison.Ordinal);
        foreach (var episode in season.GetProperty("episodes").EnumerateArray().Where(e => e.GetProperty("candidates").GetArrayLength() > 0))
            Assert.Contains("German", Name(Assert.Single(episode.GetProperty("candidates").EnumerateArray(), c => c.GetProperty("recommended").GetBoolean())), StringComparison.Ordinal);
    }
}
