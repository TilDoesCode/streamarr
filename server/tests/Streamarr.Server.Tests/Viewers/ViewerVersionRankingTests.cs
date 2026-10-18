using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Controllers;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Version order by the ranker score with the viewer's audio languages, and cache-only lookups.</summary>
public sealed class ViewerVersionRankingTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private const string Base = "/api/v1/viewer/catalog";
    private const string Languages = $"{Base}/works/tmdb-movie-506/versions";
    private static readonly string English = CatalogNewznabFake.LanguageReleases[0];
    private static readonly string German = CatalogNewznabFake.LanguageReleases[1];
    private static readonly string French = CatalogNewznabFake.LanguageReleases[2];
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

    private async Task<HttpClient> ViewerAsync(string name, object? permissions = null)
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password, permissions });
        using var anon = factory.CreateClient();
        return factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password));
    }

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string path, string? acceptLanguage)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (acceptLanguage is not null)
            request.Headers.TryAddWithoutValidation("Accept-Language", acceptLanguage);
        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> OkAsync(HttpClient client, string path, string? acceptLanguage = null)
    {
        var response = await GetAsync(client, path, acceptLanguage);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static string[] Names(JsonElement body) => body.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("name").GetString()!).ToArray();

    [Fact]
    public async Task WithoutALanguage_VersionsFollowTheRankerScore_AndGermanReleasesStayUnpreferred()
    {
        using var viewer = await ViewerAsync("nolang");

        var body = await OkAsync(viewer, Languages);

        Assert.Equal([English, German, French], Names(body));
        Assert.Equal([1, 2, 3], body.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("qualityRank").GetInt32()));
        Assert.Equal(["de"], body.GetProperty("versions")[1].GetProperty("languages").EnumerateArray().Select(l => l.GetString()));
        Assert.False(body.GetProperty("cacheMiss").GetBoolean());
    }

    [Theory]
    [InlineData("de-DE,de;q=0.9,en;q=0.8")]
    [InlineData("de")]
    [InlineData("*;q=0.5, de-AT")]
    public async Task AGermanAppLanguage_PutsTheGermanRelease_AboveTheEquallyGoodEnglishOne(string acceptLanguage)
    {
        using var viewer = await ViewerAsync("german");

        var body = await OkAsync(viewer, Languages, acceptLanguage);

        Assert.Equal([German, English, French], Names(body));
        var first = body.GetProperty("versions")[0];
        Assert.Equal((1, 1, true), (first.GetProperty("rank").GetInt32(), first.GetProperty("qualityRank").GetInt32(), first.GetProperty("recommended").GetBoolean()));
    }

    [Theory]
    [InlineData("en-US,en;q=0.9")]
    [InlineData("tlh")]
    [InlineData("*")]
    public async Task AnEnglishOrImplausibleAppLanguage_KeepsTheProfilesOwnOrder(string acceptLanguage)
    {
        using var viewer = await ViewerAsync("english");

        Assert.Equal([English, German, French], Names(await OkAsync(viewer, Languages, acceptLanguage)));
    }

    [Fact]
    public async Task ExplicitAudioLanguages_OverrideTheAppLanguage_BestFirst()
    {
        using var viewer = await ViewerAsync("explicit");

        var french = await OkAsync(viewer, $"{Languages}?audioLanguages=fr,de", "de-DE");
        var deduplicated = await OkAsync(viewer, $"{Languages}?audioLanguages=FR,fr,%20de%20,it,es,en", "de-DE");
        var english = await OkAsync(viewer, $"{Languages}?audioLanguages=en", "de-DE");
        var empty = await OkAsync(viewer, $"{Languages}?audioLanguages=", "de-DE");

        Assert.Equal([French, German, English], Names(french));
        Assert.Equal([French, German, English], Names(deduplicated));
        Assert.Equal([English, German, French], Names(english));
        Assert.Equal([German, English, French], Names(empty));
    }

    [Fact]
    public async Task TheLanguageAlsoRanks_TheDeviceOrder()
    {
        using var viewer = await ViewerAsync("device");
        const string profile = "videoCodecs=h264&audioCodecs=aac,dts&containers=mkv,mp4&maxAudioChannels=6";

        var body = await OkAsync(viewer, $"{Languages}?{profile}", "de");

        Assert.Equal([German, English, French], Names(body));
        Assert.All(body.GetProperty("versions").EnumerateArray(), v => Assert.Equal(v.GetProperty("rank").GetInt32(), v.GetProperty("qualityRank").GetInt32()));
        Assert.True(body.GetProperty("versions")[0].GetProperty("recommended").GetBoolean());
    }

    private const string AffinityE1 = $"{Base}/works/tmdb-tv-603-s01e01/versions";
    private const string AffinityE2 = $"{Base}/works/tmdb-tv-603-s01e02/versions";
    private static readonly string AlphaE1 = CatalogNewznabFake.AffinityReleases[0];
    private static readonly string AlphaE2 = CatalogNewznabFake.AffinityReleases[2];
    private static readonly string BetaE2 = CatalogNewznabFake.AffinityReleases[3];
    private static readonly string GammaE2 = CatalogNewznabFake.AffinityReleases[4];

    /// <summary>Reports S1E1 as played halfway with the given release.</summary>
    private static async Task PlayE1Async(HttpClient viewer, string release)
    {
        var e1 = await OkAsync(viewer, AffinityE1);
        var releaseId = e1.GetProperty("versions").EnumerateArray().Single(v => v.GetProperty("name").GetString() == release).GetProperty("releaseId").GetString();
        var progress = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "progress", workId = $"tmdb-tv-{CatalogTmdbFake.AffinityShow}-s01e01", positionTicks = ViewerApi.Ticks(20), durationTicks = ViewerApi.Ticks(45), releaseId,
        });
        progress.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task TheNextEpisode_RanksTheReleaseOfTheLastPlayedGroup_First_InTheListTheHeroAndForPlay()
    {
        using var viewer = await ViewerAsync("affinity");
        const string profile = "videoCodecs=h264&audioCodecs=aac,eac3&containers=mkv,mp4&maxAudioChannels=6";

        var before = await OkAsync(viewer, AffinityE2);
        await PlayE1Async(viewer, AlphaE1);
        var after = await OkAsync(viewer, AffinityE2);
        var device = await OkAsync(viewer, $"{AffinityE2}?{profile}");
        var hero = await OkAsync(viewer, $"{AffinityE2}?{profile}&cachedOnly=true");

        Assert.Equal(BetaE2, Names(before)[0]);
        Assert.Equal([AlphaE2, BetaE2], Names(after)[..2]);
        Assert.Equal(AlphaE2, Names(device)[0]);
        Assert.Equal(AlphaE2, Names(hero)[0]);
        var first = device.GetProperty("versions")[0];
        Assert.True(first.GetProperty("recommended").GetBoolean());
        Assert.Equal(1, first.GetProperty("rank").GetInt32());
        Assert.NotEqual(1, first.GetProperty("qualityRank").GetInt32());
    }

    [Fact]
    public async Task PlayWithoutAVersion_StartsTheAffinityPick_TheListRecommends()
    {
        var username = $"affinity-play-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password));
        await PlayE1Async(viewer, AlphaE1);
        ViewerEntity entity;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            entity = await db.Viewers.SingleAsync(v => v.Username == username);

        var catalog = factory.Services.GetRequiredService<ViewerCatalogService>();
        var pick = await catalog.RecommendedAsync(entity, WorkKey.ForEpisode(CatalogTmdbFake.AffinityShow, 1, 2), null, "en", CancellationToken.None);

        Assert.Equal(AlphaE2, pick?.Name);
    }

    [Theory]
    [InlineData("auto", EnginePreference.Auto)]
    [InlineData("native", EnginePreference.Native)]
    [InlineData("vlc", EnginePreference.Vlc)]
    public async Task TheListsRankOne_IsTheServersOwnPick_ForTheEnginePreference(string engine, EnginePreference preference)
    {
        var username = $"engine-{engine}-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password));
        ViewerEntity entity;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            entity = await db.Viewers.SingleAsync(v => v.Username == username);

        var list = await OkAsync(viewer, $"{Base}/works/tmdb-movie-{CatalogTmdbFake.Movie}/versions?{EngineProfile}&engine={engine}", "en");
        var play = await EnginePlayAsync(preference);
        var catalog = factory.Services.GetRequiredService<ViewerCatalogService>();
        var key = WorkKey.TryParse($"tmdb-movie-{CatalogTmdbFake.Movie}")!;
        var pick = await catalog.RecommendedAsync(entity, key, play, "en", CancellationToken.None);

        Assert.Equal(pick?.Name, Names(list)[0]);
        Assert.True(list.GetProperty("versions")[0].GetProperty("recommended").GetBoolean());
        // The player shows the playing version's rank the same way (ViewerPlaybackService → VersionAsync).
        foreach (var version in list.GetProperty("versions").EnumerateArray())
        {
            var playing = await catalog.VersionAsync(entity, key, version.GetProperty("releaseId").GetString()!, CancellationToken.None,
                ViewerAudioLanguages.ForPlayback(null, "en"), play);
            Assert.Equal(version.GetProperty("rank").GetInt32(), playing?.Rank);
        }
    }

    [Fact]
    public async Task TheEngineHint_DecidesBetweenEqualPlaybacks_AndRejectsUnknownEngines()
    {
        using var viewer = await ViewerAsync("engine-hint");
        var path = $"{Base}/works/tmdb-movie-{CatalogTmdbFake.Movie}/versions?{EngineProfile}";

        var native = await OkAsync(viewer, $"{path}&engine=native", "en");
        var vlc = await OkAsync(viewer, $"{path}&engine=vlc", "en");
        using var invalid = await GetAsync(viewer, $"{path}&engine=exoplayer", "en");

        static string?[] Methods(JsonElement body) => body.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("predictedMethod").GetString()).ToArray();
        // The best player wins whatever the hint: the 4K HEVC release plays in VLC rather than in a transcode; equal ones follow the hint.
        Assert.Contains("vlc", Methods(native));
        Assert.Contains("direct", Methods(native));
        Assert.DoesNotContain("direct", Methods(vlc));
        Assert.Equal("vlc", Methods(vlc)[0]);
        Assert.NotEqual(Methods(native), Methods(vlc));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
    }

    // An H.264/AAC MP4 device with VLC: the 4K HEVC release only plays without a transcode in VLC.
    private const string EngineProfile = "videoCodecs=h264&audioCodecs=aac&containers=mp4&maxAudioChannels=2&vlcAvailable=true";

    /// <summary>The play context a start with <see cref="EngineProfile"/> and <c>preferences.engine</c> = <paramref name="engine"/> decides with.</summary>
    private async Task<PlayContext> EnginePlayAsync(EnginePreference engine)
    {
        var client = ClientProfile.Default with { VideoCodecs = ["h264"], AudioCodecs = ["aac"], Containers = ["mp4"], MaxAudioChannels = 2 };
        var caps = new DeviceHints(client, new TranscodeLimits()).ToCaps(ViewerCatalogController.VlcCaps(null, null, null, null, null));
        var media = factory.Services.GetRequiredService<IPlaybackMedia>();
        return new PlayContext(caps, PlaybackPreferences.Default with { Engine = engine }, await media.ServerAsync(CancellationToken.None));
    }

    [Fact]
    public async Task TheViewersLanguage_OutranksTheAffinity_WhenTheSimilarReleaseIsInAnotherLanguage()
    {
        using var viewer = await ViewerAsync("affinity-de");

        await PlayE1Async(viewer, AlphaE1);
        var german = await OkAsync(viewer, AffinityE2, "de");
        var english = await OkAsync(viewer, AffinityE2, "en");

        Assert.Equal([GammaE2, BetaE2, AlphaE2], Names(german));
        Assert.Equal(AlphaE2, Names(english)[0]);
    }

    [Theory]
    [InlineData("deu1")]
    [InlineData("german")]
    [InlineData("de-DE")]
    [InlineData("d")]
    public async Task InvalidAudioLanguages_Answer400(string value)
    {
        using var viewer = await ViewerAsync("badlang");

        var response = await GetAsync(viewer, $"{Languages}?audioLanguages={Uri.EscapeDataString(value)}", null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("invalid_query", await ViewerApi.ErrorCodeAsync(response));
    }

    [Fact]
    public async Task CachedOnly_OnAMiss_AnswersEmptyWithCacheMiss_WithoutSearching_AndOnAHit_TheRankedList()
    {
        factory.Clock.Advance(TimeSpan.FromSeconds(601));
        using var viewer = await ViewerAsync("cached");
        var searches = factory.Newznab.Searches;

        var movieMiss = await OkAsync(viewer, $"{Languages}?cachedOnly=true&refresh=true");
        var episodeMiss = await OkAsync(viewer, $"{Base}/works/tmdb-tv-600-s02e01/versions?cachedOnly=true");
        Assert.Equal(searches, factory.Newznab.Searches);

        await OkAsync(viewer, Languages);
        await OkAsync(viewer, $"{Base}/series/600/seasons/2?availability=true");
        var searched = factory.Newznab.Searches;
        var movieHit = await OkAsync(viewer, $"{Languages}?cachedOnly=true", "de");
        var episodeHit = await OkAsync(viewer, $"{Base}/works/tmdb-tv-600-s02e01/versions?cachedOnly=true");

        foreach (var (miss, mediaType) in new[] { (movieMiss, "movie"), (episodeMiss, "episode") })
        {
            Assert.True(miss.GetProperty("cacheMiss").GetBoolean());
            Assert.Empty(miss.GetProperty("versions").EnumerateArray());
            Assert.Equal(mediaType, miss.GetProperty("mediaType").GetString());
        }
        Assert.Equal(searched, factory.Newznab.Searches);
        Assert.Equal([German, English, French], Names(movieHit));
        Assert.Equal((false, true), (movieHit.GetProperty("cacheMiss").GetBoolean(), movieHit.GetProperty("fromCache").GetBoolean()));
        Assert.Equal(["Catalog.Show.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP"], Names(episodeHit));
        Assert.False(episodeHit.GetProperty("cacheMiss").GetBoolean());
    }

    [Fact]
    public async Task CachedOnly_KeepsTheAgeGate()
    {
        using var kid = await ViewerAsync("kid", new { maxAge = 12, blockUnrated = true });

        var response = await GetAsync(kid, $"{Base}/works/tmdb-movie-{CatalogTmdbFake.RatedR}/versions?cachedOnly=true", null);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("age_restricted", await ViewerApi.ErrorCodeAsync(response));
    }

    [Theory]
    [InlineData("fr,de", "de", new[] { "fr", "de" })]
    [InlineData(null, "de-CH, en;q=0.5", new[] { "de" })]
    [InlineData(null, "en;q=0.4, it;q=0.8", new[] { "it" })]
    [InlineData(null, "x-klingon, de;q=0.1", new[] { "de" })]
    [InlineData(null, "", null)]
    [InlineData(null, "*", null)]
    [InlineData("", "de", new[] { "de" })]
    [InlineData("de,en,fr,it,es,nl", null, new[] { "de", "en", "fr", "it" })]
    [InlineData("ger,de,eng", null, new[] { "de", "en" })]
    [InlineData("und", "fr", new[] { "fr" })]
    public void AudioLanguages_ResolveExplicitThenAppLanguage(string? requested, string? acceptLanguage, string[]? expected)
        => Assert.Equal(expected, ViewerAudioLanguages.Resolve(ViewerAudioLanguages.Parse(requested), ViewerAudioLanguages.FromAcceptLanguage(acceptLanguage)));

    [Theory]
    [InlineData("ger", "en", new[] { "de" })]
    [InlineData("deu", null, new[] { "de" })]
    [InlineData("und", "en", new[] { "en" })]
    [InlineData(null, null, null)]
    public void AudioLanguages_ForPlayback_TrackCodesRankAsTheirTwoLetterCode(string? audioLanguage, string? appLanguage, string[]? expected)
        => Assert.Equal(expected, ViewerAudioLanguages.ForPlayback(audioLanguage, appLanguage));
}

/// <summary>A cache-only miss queues the spec warm-up, so a later cache-only request finds the list.</summary>
public sealed class ViewerVersionsWarmupTests(ViewerCatalogWarmupFactory factory) : IClassFixture<ViewerCatalogWarmupFactory>
{
    [Fact]
    public async Task CachedOnly_Miss_QueuesTheWarmUp_AndALaterRequestHits()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var username = $"hero-{Guid.NewGuid():N}"[..20];
        await ViewerApi.CreateAsync(admin, new { username, password = "correct horse battery" });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, "correct horse battery"));
        var warmup = factory.Services.GetRequiredService<SpecWarmupService>();
        const string path = "/api/v1/viewer/catalog/works/tmdb-movie-506/versions?cachedOnly=true";

        var miss = await viewer.GetFromJsonAsync<JsonElement>(path);
        Assert.True(miss.GetProperty("cacheMiss").GetBoolean());
        Assert.True(warmup.Queued > 0);

        // Wait for the background lookup itself (bounded), not for a guessed delay.
        var deadline = DateTime.UtcNow.AddSeconds(30);
        JsonElement hit;
        do
        {
            while (!warmup.Idle && DateTime.UtcNow < deadline)
                await Task.Delay(20);
            hit = await viewer.GetFromJsonAsync<JsonElement>(path);
        }
        while (DateTime.UtcNow < deadline && hit.GetProperty("cacheMiss").GetBoolean());

        Assert.False(hit.GetProperty("cacheMiss").GetBoolean());
        Assert.Equal(CatalogNewznabFake.LanguageReleases, hit.GetProperty("versions").EnumerateArray().Select(v => v.GetProperty("name").GetString()));
        Assert.Equal(1, factory.Newznab.Searches);
    }
}
