using System.Net;
using System.Net.Http.Headers;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Own fixture: exhausting a window must not starve the other diagnostics tests.</summary>
public sealed class DiagnosticsRateLimitTests(DiagnosticsFactory factory) : IClassFixture<DiagnosticsFactory>
{
    private async Task<HttpClient> SecondViewerAsync(string name)
    {
        await factory.SeedAsync();
        using var admin = await factory.AdminAsync();
        await ViewerApi.CreateAsync(admin, new { username = name, password = DiagnosticsFactory.ViewerPassword });
        using var anon = factory.CreateClient();
        return factory.Viewer(await ViewerApi.AccessTokenAsync(anon, name, DiagnosticsFactory.ViewerPassword));
    }

    /// <summary>What the app sends for one test: limits, warm-up + 8 pings, 4 long downloads, a few large uploads.</summary>
    private static async Task RunClientPatternAsync(HttpClient client)
    {
        for (var i = 0; i < 10; i++)
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);
        var downloads = Enumerable.Range(0, 4).Select(async _ =>
        {
            using var response = await client.GetAsync("/api/v1/viewer/diagnostics/speed/download?bytes=2147483648", HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            await using var body = await response.Content.ReadAsStreamAsync();
            await body.ReadExactlyAsync(new byte[256 * 1024]);
        });
        await Task.WhenAll(downloads);
        for (var i = 0; i < 6; i++)
        {
            var content = new ByteArrayContent(new byte[64 * 1024]);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/v1/viewer/diagnostics/speed/upload", content)).StatusCode);
        }
    }

    [Fact]
    public async Task ThreeConsecutiveSpeedTests_ForOneUser_NeverHitTheLimit()
    {
        using var viewer = await SecondViewerAsync("diag-three");
        for (var run = 0; run < 3; run++)
            await RunClientPatternAsync(viewer);
    }

    [Fact]
    public async Task Limits_ArePerUser_NotPerIp()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        using var neighbour = await SecondViewerAsync("diag-neighbour");

        for (var i = 0; i < DiagnosticsRateLimits.ReportPerMinute; i++)
            Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await viewer.GetAsync("/api/v1/viewer/diagnostics")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);

        for (var i = 1; i < DiagnosticsRateLimits.SpeedTestPerMinute; i++)
            await viewer.GetAsync("/api/v1/viewer/diagnostics/ping");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await viewer.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);

        // Same IP, another account: its own windows are untouched.
        Assert.Equal(HttpStatusCode.OK, (await neighbour.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await neighbour.GetAsync("/api/v1/viewer/diagnostics")).StatusCode);
        using var admin = await factory.AdminAsync();
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/diagnostics/ping")).StatusCode);
    }
}
