using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>A German viewer reads German metadata, but indexers are always searched in the server's metadata language.</summary>
public sealed class IndexerLanguageTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>
{
    private const string Base = "/api/v1/viewer/catalog";

    [Fact]
    public async Task GermanViewer_SearchesIndexersInTheServerLanguage()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        await ViewerApi.CreateAsync(admin, new { username = "deutsch", password = "correct horse battery" });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, "deutsch", "correct horse battery"));
        viewer.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "de-DE,de;q=0.9");

        var title = await GetAsync(viewer, $"{Base}/movies/501");
        Assert.Equal("Der Catalog Movie", title.GetProperty("title").GetString());
        await GetAsync(viewer, $"{Base}/works/tmdb-movie-501/versions");
        await GetAsync(viewer, $"{Base}/works/tmdb-tv-600-s01e01/versions");

        var queries = factory.Newznab.Queries.ToList();
        Assert.NotEmpty(queries);
        Assert.All(queries, q => Assert.Null(q.Language));
        // id-based searches: no free-text term, so no translated title can reach an indexer
        Assert.All(queries, q => Assert.Null(q.Term));
    }

    [Fact]
    public async Task ResumeItems_CarryTheTitleInTheViewersLanguage_EpisodesTheirSeriesTitle()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        await ViewerApi.CreateAsync(admin, new { username = "resumetitle", password = "correct horse battery" });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, "resumetitle", "correct horse battery"));
        var hour = ViewerApi.Ticks(60);
        foreach (var workId in new[] { "tmdb-movie-501", "tmdb-tv-600-s01e01", "tmdb-movie-999" })
        {
            using var response = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
                new { @event = "progress", workId, positionTicks = hour / 2, durationTicks = hour, playbackId = $"pb-{workId}" });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        async Task<Dictionary<string, string?>> TitlesAsync(string? language)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/viewer/watch/resume");
            if (language is not null)
                request.Headers.TryAddWithoutValidation("Accept-Language", language);
            using var response = await viewer.SendAsync(request);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            return body.EnumerateArray().ToDictionary(i => i.GetProperty("workId").GetString()!, i => i.GetProperty("title").GetString());
        }

        var english = await TitlesAsync(null);
        Assert.Equal(("Catalog Movie", "Catalog Show", null), (english["tmdb-movie-501"], english["tmdb-tv-600-s01e01"], english["tmdb-movie-999"]));
        var german = await TitlesAsync("de");
        Assert.Equal(("Der Catalog Movie", "Die Catalog Show"), (german["tmdb-movie-501"], german["tmdb-tv-600-s01e01"]));
    }

    private static async Task<JsonElement> GetAsync(HttpClient client, string url)
    {
        using var response = await client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
}
