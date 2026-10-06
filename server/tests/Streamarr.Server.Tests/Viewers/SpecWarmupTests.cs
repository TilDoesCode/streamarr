using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Spec warm-up: list fetches queue background version lookups; the next fetch carries the specs.</summary>
public sealed class SpecWarmupTests(ViewerCatalogWarmupFactory factory) : IClassFixture<ViewerCatalogWarmupFactory>
{
    private const string Base = "/api/v1/viewer/catalog";

    private async Task<HttpClient> ViewerAsync()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var username = $"warm-{Guid.NewGuid():N}"[..20];
        await ViewerApi.CreateAsync(admin, new { username, password = "correct horse battery" });
        using var anon = factory.CreateClient();
        return factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, "correct horse battery"));
    }

    private static async Task<Dictionary<string, JsonElement>> DiscoverAsync(HttpClient viewer)
    {
        var response = await viewer.GetAsync($"{Base}/discover");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("rows").EnumerateArray()
            .SelectMany(r => r.GetProperty("items").EnumerateArray())
            .GroupBy(i => i.GetProperty("workId").GetString()!)
            .ToDictionary(g => g.Key, g => g.First());
    }

    [Fact]
    public async Task DiscoverTitles_GetTheirSpecInTheBackground_OncePerCooldown()
    {
        using var viewer = await ViewerAsync();
        var warmup = factory.Services.GetRequiredService<SpecWarmupService>();

        var first = await DiscoverAsync(viewer);
        Assert.Contains(first.Values, i => i.GetProperty("spec").ValueKind == JsonValueKind.Null);
        Assert.True(warmup.Queued > 0);

        // Wait for the background lookups themselves (bounded), not for a guessed delay.
        var deadline = DateTime.UtcNow.AddSeconds(30);
        Dictionary<string, JsonElement> later;
        bool Warm(Dictionary<string, JsonElement> cards) => cards["tmdb-movie-501"].GetProperty("spec").ValueKind != JsonValueKind.Null
            && cards["tmdb-tv-600"].GetProperty("spec").ValueKind != JsonValueKind.Null;
        do
        {
            while (!warmup.Idle && DateTime.UtcNow < deadline)
                await Task.Delay(20);
            later = await DiscoverAsync(viewer);
        }
        while (DateTime.UtcNow < deadline && !(warmup.Idle && Warm(later)));

        Assert.True(warmup.Idle, $"queued {warmup.Queued}, started {warmup.StartedToday}");
        Assert.Equal("4K", later["tmdb-movie-501"].GetProperty("spec").GetProperty("resolution").GetString());
        Assert.Equal("1080p", later["tmdb-tv-600"].GetProperty("spec").GetProperty("resolution").GetString());
        var started = warmup.StartedToday;
        var queued = warmup.Queued;
        Assert.InRange(started, 1, first.Count);

        // Within the cooldown a fetch queues nothing (Request runs inside the request, so no wait is needed).
        await DiscoverAsync(viewer);
        Assert.Equal(queued, warmup.Queued);
        Assert.Equal(started, warmup.StartedToday);
    }
}
