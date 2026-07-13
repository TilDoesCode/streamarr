using System.Net;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public class MetricsEndpointTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task Metrics_ReportSessionsConnectionsBytesAndProviders()
    {
        using var client = fixture.CreateClient();

        // Drive some traffic so the counters are non-trivial.
        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId });
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        _ = await client.GetByteArrayAsync(resolved.StreamUrl!);

        var metrics = await client.GetFromJsonAsync<MetricsResponse>("/api/v1/metrics");
        Assert.NotNull(metrics);

        // sessions + bytes accumulated
        Assert.True(metrics!.Sessions.OpenedTotal >= 1);
        Assert.True(metrics.Sessions.Active >= 1);
        Assert.True(metrics.BytesServedTotal > 0);

        // connection budget surfaced with the mock provider present
        Assert.Equal(12, metrics.Connections.Budget); // fixture sets ConnectionBudget=12
        Assert.True(metrics.Connections.InUse >= 0);
        var provider = Assert.Single(metrics.Connections.Providers);
        Assert.Equal("mock", provider.Name);

        // resolves counted
        Assert.True(metrics.Resolves.Total >= 1);

        // search-cache metrics present (hit rate within [0,1])
        Assert.InRange(metrics.SearchCache.HitRate, 0d, 1d);
    }

    [Fact]
    public async Task Metrics_RequireAuthentication()
    {
        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync("/api/v1/metrics");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
