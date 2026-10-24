using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Server default and per-viewer ranking profiles: precedence, media types, permission, redaction, fallback on delete, live re-ranking.</summary>
public sealed class RankingProfileTests : IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private const string MovieVersions = "/api/v1/viewer/catalog/works/tmdb-movie-501/versions";
    private const string Defaults = "/api/v1/config/profile-defaults";
    private const string Choice = "/api/v1/viewer/me/ranking-profile";
    private static readonly string Uhd = CatalogNewznabFake.MovieReleases[0];
    private static readonly string Hd720 = CatalogNewznabFake.MovieReleases[2];

    private readonly ViewerCatalogFactory _factory = new();
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await _factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        _factory.Dispose();
        return Task.CompletedTask;
    }

    private async Task<(HttpClient Client, string Id)> ViewerAsync(string name)
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        var created = await ViewerApi.CreateAsync(_admin, new { username, password = Password });
        using var anon = _factory.CreateClient();
        return (_factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password)), created.GetProperty("viewer").GetProperty("id").GetString()!);
    }

    private async Task<string> ProfileAsync(object body)
    {
        var response = await _admin.PostAsJsonAsync("/api/v1/config/profiles", body);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
    }

    private Task<string> BandwidthProfileAsync(string appliesTo = "both")
        => ProfileAsync(new { name = "Spart Bandbreite", description = "Höchstens 1080p, bevorzugt 720p", appliesTo, preferredResolutions = new[] { "720p", "1080p" } });

    private static async Task<JsonElement> OkAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<string[]> NamesAsync(HttpClient viewer)
        => (await OkAsync(await viewer.GetAsync(MovieVersions))).GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("name").GetString()!).ToArray();

    private async Task PutDefaultsAsync(object body) => await OkAsync(await _admin.PutAsJsonAsync(Defaults, body));

    private static Task<HttpResponseMessage> ChooseAsync(HttpClient viewer, string? profileId) => viewer.PutAsJsonAsync(Choice, new { profileId });

    [Fact]
    public async Task FreshInstall_RanksWithStandard_AndViewersMayChoose()
    {
        var defaults = await OkAsync(await _admin.GetAsync(Defaults));
        Assert.Equal("default", defaults.GetProperty("defaultProfileId").GetString());
        Assert.True(defaults.GetProperty("viewersMayChoose").GetBoolean());
        Assert.Equal("default", defaults.GetProperty("effective").GetProperty("movie").GetProperty("id").GetString());

        var (viewer, _) = await ViewerAsync("fresh");
        var choice = await OkAsync(await viewer.GetAsync(Choice));
        Assert.Equal(JsonValueKind.Null, choice.GetProperty("profileId").ValueKind);
        Assert.True(choice.GetProperty("canChoose").GetBoolean());
        Assert.Equal(("default", "server"), (choice.GetProperty("movie").GetProperty("id").GetString(), choice.GetProperty("movie").GetProperty("source").GetString()));
        var standard = Assert.Single(choice.GetProperty("profiles").EnumerateArray());
        Assert.True(standard.GetProperty("serverDefault").GetBoolean());
        Assert.Equal("1080p", standard.GetProperty("traits").GetProperty("preferredResolution").GetString());
    }

    [Fact]
    public async Task SwitchingTheViewerProfile_ReranksTheCachedList_WithoutAnotherIndexerSearch()
    {
        var bandwidth = await BandwidthProfileAsync();
        var (viewer, viewerId) = await ViewerAsync("switch");
        var before = await NamesAsync(viewer);
        Assert.NotEqual(Hd720, before[0]);
        var searches = _factory.Newznab.Searches;

        var chosen = await OkAsync(await ChooseAsync(viewer, bandwidth));
        Assert.Equal(bandwidth, chosen.GetProperty("profileId").GetString());
        Assert.Equal(("Spart Bandbreite", "viewer"), (chosen.GetProperty("series").GetProperty("name").GetString(), chosen.GetProperty("series").GetProperty("source").GetString()));

        var after = await NamesAsync(viewer);
        Assert.Equal(Hd720, after[0]);
        Assert.Equal(searches, _factory.Newznab.Searches);

        // Play without a version starts the same pick (playback auto-pick goes through the same ranking).
        await using (var db = await _factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
        {
            var entity = await db.Viewers.AsNoTracking().SingleAsync(v => v.Id == viewerId);
            var recommended = await _factory.Services.GetRequiredService<ViewerCatalogService>()
                .RecommendedAsync(entity, Streamarr.Server.Viewers.Watch.WorkKey.TryParse("tmdb-movie-501")!, null, null, default);
            Assert.Equal(Hd720, recommended!.Name);
        }

        // Another viewer on the server default keeps the Standard order; back to the default restores it.
        var (other, _) = await ViewerAsync("other");
        Assert.Equal(before, await NamesAsync(other));
        await OkAsync(await ChooseAsync(viewer, null));
        Assert.Equal(before, await NamesAsync(viewer));
    }

    [Fact]
    public async Task TheServerDefault_RanksViewersWithoutAChoice_AndAnEditTakesEffectAtOnce()
    {
        var bandwidth = await BandwidthProfileAsync();
        var (viewer, _) = await ViewerAsync("follows");
        var standardOrder = await NamesAsync(viewer);

        await PutDefaultsAsync(new { defaultProfileId = bandwidth });
        Assert.Equal(Hd720, (await NamesAsync(viewer))[0]);

        // Editing the profile (now 4K first) re-ranks without a restart.
        var edit = await _admin.PutAsJsonAsync($"/api/v1/config/profiles/{bandwidth}",
            new { name = "Spart Bandbreite", appliesTo = "both", preferredResolutions = new[] { "2160p", "1080p" } });
        Assert.True(edit.IsSuccessStatusCode, await edit.Content.ReadAsStringAsync());
        Assert.Equal(Uhd, (await NamesAsync(viewer))[0]);

        await PutDefaultsAsync(new { defaultProfileId = "default" });
        Assert.Equal(standardOrder, await NamesAsync(viewer));
    }

    [Fact]
    public async Task PerMediaType_AShowsOnlyProfileNeverRanksMovies()
    {
        var shows = await BandwidthProfileAsync("shows");
        var movies = await ProfileAsync(new { name = "Kino 4K", appliesTo = "movies", preferredResolutions = new[] { "2160p", "1080p" } });

        var mismatch = await _admin.PutAsJsonAsync(Defaults, new { movieProfileId = shows });
        Assert.Equal(HttpStatusCode.BadRequest, mismatch.StatusCode);
        Assert.Equal("profile_media_type_mismatch", await ViewerApi.ErrorCodeAsync(mismatch));
        var unknown = await _admin.PutAsJsonAsync(Defaults, new { defaultProfileId = "nope" });
        Assert.Equal("unknown_profile", await ViewerApi.ErrorCodeAsync(unknown));

        // A series-only general default: series use it, movies fall back to Standard; a movie override wins for movies.
        var body = await OkAsync(await _admin.PutAsJsonAsync(Defaults, new { defaultProfileId = shows }));
        Assert.Equal(("default", shows), (body.GetProperty("effective").GetProperty("movie").GetProperty("id").GetString(), body.GetProperty("effective").GetProperty("series").GetProperty("id").GetString()));
        body = await OkAsync(await _admin.PutAsJsonAsync(Defaults, new { defaultProfileId = shows, movieProfileId = movies }));
        Assert.Equal(movies, body.GetProperty("effective").GetProperty("movie").GetProperty("id").GetString());

        // A viewer choosing the series-only profile keeps the server's movie ranking.
        var (viewer, _) = await ViewerAsync("mediatype");
        var choice = await OkAsync(await ChooseAsync(viewer, shows));
        Assert.Equal((movies, "server"), (choice.GetProperty("movie").GetProperty("id").GetString(), choice.GetProperty("movie").GetProperty("source").GetString()));
        Assert.Equal((shows, "viewer"), (choice.GetProperty("series").GetProperty("id").GetString(), choice.GetProperty("series").GetProperty("source").GetString()));
        Assert.Equal(Uhd, (await NamesAsync(viewer))[0]);
    }

    [Fact]
    public void Resolver_Precedence_ViewerThenServerDefaultThenStandard()
    {
        var resolver = _factory.Services.GetRequiredService<RankingProfileResolver>();
        var profiles = _factory.Services.GetRequiredService<ProfileConfigService>();
        var shows = BandwidthProfileAsync("shows").GetAwaiter().GetResult();

        Assert.Equal(("default", "server"), (resolver.ForChoice(null, MediaType.Tv).Profile.Id, resolver.ForChoice(null, MediaType.Tv).Source));
        Assert.Equal(("default", "server"), (resolver.ForChoice("missing", MediaType.Tv).Profile.Id, resolver.ForChoice("missing", MediaType.Tv).Source));
        Assert.Equal((shows, "viewer"), (resolver.ForChoice(shows, MediaType.Tv).Profile.Id, resolver.ForChoice(shows, MediaType.Tv).Source));
        Assert.Equal("default", resolver.ForChoice(shows, MediaType.Movie).Profile.Id);

        var before = resolver.ServerDefault(MediaType.Tv).Key;
        Assert.Null(profiles.UpdateDefaultsAsync(new ProfileDefaults(shows, null, null, ViewersMayChoose: false), default).GetAwaiter().GetResult());
        Assert.NotEqual(before, resolver.ServerDefault(MediaType.Tv).Key);
        Assert.Equal(shows, resolver.ServerDefault(MediaType.Tv).Profile.Id);
        Assert.Equal("default", resolver.ServerDefault(MediaType.Movie).Profile.Id);
        // Choice disabled: a stored choice is ignored (and kept for when it is allowed again).
        Assert.Equal("server", resolver.ForChoice(shows, MediaType.Tv).Source);
    }

    [Fact]
    public async Task ViewerChoiceDisabled_PutIsForbidden_AndEveryoneFollowsTheServer()
    {
        var bandwidth = await BandwidthProfileAsync();
        var (viewer, _) = await ViewerAsync("disabled");
        await OkAsync(await ChooseAsync(viewer, bandwidth));
        Assert.Equal(Hd720, (await NamesAsync(viewer))[0]);

        await PutDefaultsAsync(new { viewersMayChoose = false });
        var refused = await ChooseAsync(viewer, "default");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("profile_choice_disabled", await ViewerApi.ErrorCodeAsync(refused));
        var choice = await OkAsync(await viewer.GetAsync(Choice));
        Assert.False(choice.GetProperty("canChoose").GetBoolean());
        Assert.Equal("server", choice.GetProperty("movie").GetProperty("source").GetString());
        Assert.NotEqual(Hd720, (await NamesAsync(viewer))[0]);

        // Allowed again: the stored choice applies again.
        await PutDefaultsAsync(new { viewersMayChoose = true });
        Assert.Equal(Hd720, (await NamesAsync(viewer))[0]);

        var unknown = await ChooseAsync(viewer, "no-such-profile");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Equal("unknown_profile", await ViewerApi.ErrorCodeAsync(unknown));
    }

    [Fact]
    public async Task DeletingTheDefaultAndAViewersChoice_FallsBackToStandard_WithoutDanglingIds()
    {
        var bandwidth = await BandwidthProfileAsync();
        var (viewer, viewerId) = await ViewerAsync("deleted");
        await PutDefaultsAsync(new { defaultProfileId = bandwidth, seriesProfileId = bandwidth });
        await OkAsync(await ChooseAsync(viewer, bandwidth));
        Assert.Equal(Hd720, (await NamesAsync((await ViewerAsync("follower")).Client))[0]);

        var deleted = await _admin.DeleteAsync($"/api/v1/config/profiles/{bandwidth}");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var names = await NamesAsync(viewer);
        Assert.NotEqual(Hd720, names[0]);
        var defaults = await OkAsync(await _admin.GetAsync(Defaults));
        Assert.Equal("default", defaults.GetProperty("defaultProfileId").GetString());
        Assert.Equal(JsonValueKind.Null, defaults.GetProperty("seriesProfileId").ValueKind);
        var choice = await OkAsync(await viewer.GetAsync(Choice));
        Assert.Equal(JsonValueKind.Null, choice.GetProperty("profileId").ValueKind);
        await using var db = await _factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync();
        Assert.Null((await db.Viewers.SingleAsync(v => v.Id == viewerId)).RankingProfileId);
    }

    [Fact]
    public async Task ViewerProfileList_ShowsTraitsOnly_NeverRulesOrGroups()
    {
        await ProfileAsync(new
        {
            name = "4K HDR",
            appliesTo = "both",
            preferredResolutions = new[] { "2160p", "1080p" },
            preferredCodecs = new[] { "x265" },
            preferredLanguages = new[] { "de", "en" },
            groupAllowList = new[] { "SECRETGROUP" },
            groupDenyList = new[] { "HIDDENGROUP" },
            importedFrom = "radarr",
            customFormats = new[] { new { name = "HDR10 Secret Boost", score = 500, conditions = new[] { new { name = "hdr", implementation = "ReleaseTitleSpecification", value = "HDR" } } } },
        });
        var (viewer, _) = await ViewerAsync("redact");

        var raw = await (await viewer.GetAsync(Choice)).Content.ReadAsStringAsync();
        foreach (var secret in new[] { "SECRETGROUP", "HIDDENGROUP", "Secret Boost", "radarr", "groupAllow", "customFormats", "weight", "sizeBands" })
            Assert.DoesNotContain(secret, raw, StringComparison.OrdinalIgnoreCase);
        var profile = JsonDocument.Parse(raw).RootElement.GetProperty("profiles").EnumerateArray().Single(p => p.GetProperty("name").GetString() == "4K HDR");
        var traits = profile.GetProperty("traits");
        Assert.Equal(("2160p", "prefer", "hevc", false), (traits.GetProperty("preferredResolution").GetString(), traits.GetProperty("hdr").GetString(),
            traits.GetProperty("codec").GetString(), traits.GetProperty("savesBandwidth").GetBoolean()));
        Assert.Equal(["movie", "series"], profile.GetProperty("mediaTypes").EnumerateArray().Select(t => t.GetString()));
    }

    [Fact]
    public async Task AProfilesRejections_HideReleasesForItsViewers_AndDecideEpisodeAvailability()
    {
        var only1080 = await ProfileAsync(new
        {
            name = "Nur 1080p",
            appliesTo = "both",
            minimumCustomFormatScore = 10,
            customFormats = new[] { new { name = "1080p", score = 10, conditions = new[] { new { name = "res", implementation = "ResolutionSpecification", value = "1080p" } } } },
        });
        var nothing = await ProfileAsync(new
        {
            name = "Nichts",
            appliesTo = "shows",
            minimumCustomFormatScore = 10,
            customFormats = new[] { new { name = "never", score = 10, conditions = new[] { new { name = "t", implementation = "ReleaseTitleSpecification", value = "NO-SUCH-RELEASE" } } } },
        });
        var (viewer, _) = await ViewerAsync("rejects");
        Assert.Contains(Uhd, await NamesAsync(viewer));
        await OkAsync(await ChooseAsync(viewer, only1080));
        var names = await NamesAsync(viewer);
        Assert.DoesNotContain(Uhd, names);
        Assert.DoesNotContain(Hd720, names);
        Assert.All(names, n => Assert.Contains("1080p", n, StringComparison.Ordinal));

        await OkAsync(await viewer.GetAsync($"/api/v1/viewer/catalog/series/{CatalogTmdbFake.Show}/seasons/1?availability=true"));
        var catalog = _factory.Services.GetRequiredService<ViewerCatalogService>();
        var resolver = _factory.Services.GetRequiredService<RankingProfileResolver>();
        Assert.True(catalog.EpisodeAvailable(CatalogTmdbFake.Show, 1, 1, resolver.ServerDefault(MediaType.Tv)));
        Assert.False(catalog.EpisodeAvailable(CatalogTmdbFake.Show, 1, 1, resolver.ForChoice(nothing, MediaType.Tv)));
    }

    [Fact]
    public async Task PreDownloadPick_RanksTheNextEpisodeWithTheRequestersProfile()
    {
        var resolver = _factory.Services.GetRequiredService<NextEpisodeResolver>();
        const string pack = "Catalog.Show.S01.1080p.BluRay.DD5.1.x264-PACK";
        const string single = "Catalog.Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP";
        var web = await ProfileAsync(new { name = "WEB zuerst", appliesTo = "shows", preferredResolutions = new[] { "1080p" }, preferredSources = new[] { "WEB-DL" } });
        var bluRay = await ProfileAsync(new { name = "BluRay zuerst", appliesTo = "shows", preferredResolutions = new[] { "1080p" }, preferredSources = new[] { "BluRay" } });
        var profiles = _factory.Services.GetRequiredService<ProfileConfigService>();
        var store = _factory.Services.GetRequiredService<Streamarr.Core.Media.IReleaseStore>();

        var forWeb = await resolver.ResolveAsync($"tmdb-tv-{CatalogTmdbFake.Show}-s01e01", null, false, 0, default, profile: profiles.FindById(web));
        var forBluRay = await resolver.ResolveAsync($"tmdb-tv-{CatalogTmdbFake.Show}-s01e01", null, false, 0, default, profile: profiles.FindById(bluRay));

        Assert.Equal(single, store.Get(forWeb!.ReleaseId)!.Release.Title);
        Assert.Equal(pack, store.Get(forBluRay!.ReleaseId)!.Release.Title);
    }
}
