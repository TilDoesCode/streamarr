using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>A title with 150 versions: one indexer search, then the cached list answers quickly with every device prediction.</summary>
public sealed class ViewerVersionsLatencyTests(ViewerCatalogFactory factory, ITestOutputHelper output) : IClassFixture<ViewerCatalogFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private const string Versions = "/api/v1/viewer/catalog/works/tmdb-movie-507/versions";
    // The query a TV client sends (device profile, VLC fallback, audio languages).
    private const string TvProfile =
        "videoCodecs=h264,hevc,av1,vp9&audioCodecs=aac,ac3,eac3,opus&audioPassthrough=ac3,eac3&containers=mkv,mp4"
        + "&hdrFormats=hdr10&supports10Bit=true&maxAudioChannels=6&maxHeight=2160&vlcAvailable=true&vlcVideoCodecs=h264,hevc,av1"
        + "&audioLanguages=de,en";
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

    [Fact]
    public async Task ACachedListOf150Versions_AnswersWithoutASearch_AndQuickly()
    {
        var username = $"many-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, Password));

        // Warms the pipeline (JIT, first search) so the first 150-version request measures the search itself.
        await TimedAsync(viewer, $"/api/v1/viewer/catalog/works/tmdb-movie-506/versions?{TvProfile}");
        var first = await TimedAsync(viewer, $"{Versions}?{TvProfile}");
        var searches = factory.Newznab.Searches;
        var warm = new List<double>();
        JsonElement body = default;
        for (var i = 0; i < 10; i++)
        {
            var (ms, json, _) = await TimedAsync(viewer, $"{Versions}?{TvProfile}");
            warm.Add(ms);
            body = json;
        }
        warm.Sort();
        var median = warm[warm.Count / 2];
        output.WriteLine($"versions={body.GetProperty("versions").GetArrayLength()} cold search={first.Ms:F1}ms warm median={median:F1}ms max={warm[^1]:F1}ms payload={first.Bytes / 1024.0:F1}KiB");

        Assert.Equal(searches, factory.Newznab.Searches);
        Assert.True(body.GetProperty("versions").GetArrayLength() >= 100);
        Assert.All(body.GetProperty("versions").EnumerateArray(), v => Assert.True(v.TryGetProperty("predictedMethod", out _)));
        // Generous for CI: a cached list is ranked and predicted in memory (single-digit ms locally).
        Assert.True(median < 250, $"warm median {median:F1}ms");
    }

    private static async Task<(double Ms, JsonElement Body, long Bytes)> TimedAsync(HttpClient client, string path)
    {
        var watch = Stopwatch.StartNew();
        using var response = await client.GetAsync(path);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        watch.Stop();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {(int)response.StatusCode}");
        return (watch.Elapsed.TotalMilliseconds, JsonSerializer.Deserialize<JsonElement>(bytes), bytes.LongLength);
    }
}
