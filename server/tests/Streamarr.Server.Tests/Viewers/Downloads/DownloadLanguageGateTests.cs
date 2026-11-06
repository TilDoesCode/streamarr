using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Fix round 1 (V1-06): the plan and every recommendation stay in the best audio language the viewer can get, even against a better picture.</summary>
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

    [Fact]
    public async Task ThePlanFallback_KeepsTheViewersLanguage_OverABetterPictureInAnotherOne()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "lang-plan");
        var anchor = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = $"tmdb-tv-{CatalogTmdbFake.AffinityShow}-s01e01", device = Dl.AndroidTv }))
            .GetProperty("candidates").EnumerateArray().First(c => Name(c).EndsWith("-ALPHA", StringComparison.Ordinal));

        var plan = await Dl.PostAsync(viewer, $"{Base}/plan", new
        {
            anchorWorkId = $"tmdb-tv-{CatalogTmdbFake.AffinityShow}-s01e01",
            anchorReleaseId = anchor.GetProperty("version").GetProperty("releaseId").GetString(),
            workIds = new[] { Episode(1), Episode(2) },
            device = Dl.AndroidTv,
            audioLanguages = new[] { "de" },
        });

        Assert.All(plan.GetProperty("items").EnumerateArray(), item =>
        {
            Assert.Equal("best_available", item.GetProperty("match").GetString());
            Assert.Contains("German", Name(item.GetProperty("candidate")), StringComparison.Ordinal);
        });
    }

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
