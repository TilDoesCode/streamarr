using System.Net;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

public sealed class TmdbProbeTests
{
    private static TmdbClient Client(StubHttpMessageHandler handler, string apiKey = "test-key")
        => new(new HttpClient(handler), new TmdbOptions { ApiKey = apiKey }, retryDelay: static (_, _) => Task.CompletedTask);

    [Fact]
    public async Task Probe_WithoutKey_IsNotConfiguredAndSendsNothing()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(HttpStatusCode.OK));

        var result = await Client(handler, apiKey: "").ProbeAsync(default);

        Assert.Equal("not_configured", result!.ErrorCode);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Probe_Success_HitsConfigurationOnce()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(HttpStatusCode.OK));

        var result = await Client(handler).ProbeAsync(default);

        Assert.True(result!.Reachable);
        var request = Assert.Single(handler.Requests);
        Assert.EndsWith("/configuration", request.AbsolutePath);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "auth_failed")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "http_error")]
    public async Task Probe_Failure_IsClassifiedAndNotRetried(HttpStatusCode status, string code)
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(status));

        var result = await Client(handler).ProbeAsync(default);

        Assert.False(result!.Reachable);
        Assert.Equal(code, result.ErrorCode);
        Assert.Single(handler.Requests);
        Assert.DoesNotContain("test-key", result.Error);
    }

    [Fact]
    public async Task Probe_NetworkFailure_IsUnreachable()
    {
        var handler = new StubHttpMessageHandler(_ => throw new HttpRequestException("connection refused"));

        var result = await Client(handler).ProbeAsync(default);

        Assert.Equal("unreachable", result!.ErrorCode);
    }

    [Fact]
    public async Task CachingClient_ForwardsProbeUncached()
    {
        var handler = new StubHttpMessageHandler(_ => StubHttpMessageHandler.Status(HttpStatusCode.OK));
        var caching = new CachingTmdbClient(Client(handler), TimeSpan.FromHours(1));

        await caching.ProbeAsync(default);
        await caching.Strict.ProbeAsync(default);

        Assert.Equal(2, handler.Requests.Count);
    }
}
