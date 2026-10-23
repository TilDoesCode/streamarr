using System.Net;
using Streamarr.Server.Services.Diagnostics;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Own fixture: exhausting the per-client windows must not starve the other diagnostics tests.</summary>
public sealed class DiagnosticsRateLimitTests(DiagnosticsFactory factory) : IClassFixture<DiagnosticsFactory>
{
    [Fact]
    public async Task Report_And_SpeedTest_AreRateLimitedPerClient()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);

        for (var i = 0; i < DiagnosticsRateLimits.ReportPerMinute; i++)
            Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics")).StatusCode);
        var limited = await viewer.GetAsync("/api/v1/viewer/diagnostics");
        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);

        for (var i = 1; i < DiagnosticsRateLimits.SpeedTestPerMinute; i++)
            await viewer.GetAsync("/api/v1/viewer/diagnostics/ping");
        Assert.Equal(HttpStatusCode.TooManyRequests, (await viewer.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);
    }
}
