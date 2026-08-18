using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Streamarr.Server.Contracts;
using Streamarr.Server.Logging;

namespace Streamarr.Server.Tests.Integration;

[CollectionDefinition("logging-endpoint", DisableParallelization = true)]
public sealed class LoggingEndpointCollection;

[Collection("logging-endpoint")]
public sealed class LoggingEndpointTests : IClassFixture<AuthEndpointTests.Factory>
{
    private readonly AuthEndpointTests.Factory _factory;

    public LoggingEndpointTests(AuthEndpointTests.Factory factory) => _factory = factory;

    [Fact]
    public async Task EndpointRequiresAdminPolicy()
    {
        using var anonymous = _factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/logs")).StatusCode);

        using var machine = _factory.CreateClient();
        machine.DefaultRequestHeaders.Authorization = new("Bearer", "machine-key-for-auth-tests-0123456789");
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/logs")).StatusCode);

        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/logs?source=core")).StatusCode);

        var authNoise = await admin.GetFromJsonAsync<LogFeedResponse>(
            "/api/v1/logs?source=core&minimumLevel=information&search=AuthenticationScheme");
        Assert.NotNull(authNoise);
        Assert.Empty(authNoise.Entries);
    }

    [Fact]
    public async Task CoreFeedFiltersAndReturnsCorrelationAndSourceStatus()
    {
        var marker = "logging-endpoint-marker-" + Guid.NewGuid().ToString("N");
        var logger = _factory.Services.GetRequiredService<ILogger<LoggingEndpointTests>>();
        using (logger.BeginScope(new Dictionary<string, object>
               {
                   [LogPropertyNames.ReleaseId] = "release-log-test",
                   [LogPropertyNames.WorkId] = "work-log-test",
               }))
        {
            logger.LogWarning("Relevant diagnostic {Marker}", marker);
        }

        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();
        var feed = await admin.GetFromJsonAsync<LogFeedResponse>(
            $"/api/v1/logs?source=core&minimumLevel=warning&search={marker}&limit=10");

        Assert.NotNull(feed);
        var entry = Assert.Single(feed.Entries);
        Assert.Equal("warning", entry.Level);
        Assert.Equal("core", entry.Source);
        Assert.Equal("release-log-test", entry.ReleaseId);
        Assert.Equal("work-log-test", entry.WorkId);
        Assert.Contains(marker, entry.Message, StringComparison.Ordinal);
        Assert.Collection(
            feed.Sources,
            core =>
            {
                Assert.Equal("core", core.Source);
                Assert.True(core.Configured);
                Assert.True(core.Available);
            },
            jellyfin =>
            {
                Assert.Equal("jellyfin", jellyfin.Source);
                Assert.False(jellyfin.Configured);
                Assert.False(jellyfin.Available);
            });
    }

    [Fact]
    public async Task StreamTokenReturnsOnlyTheMatchingFingerprintForSharedRelease()
    {
        var token = new string('a', 48);
        var otherToken = new string('b', 48);
        var marker = "matching-stream-token-" + Guid.NewGuid().ToString("N");
        var otherMarker = "other-stream-token-" + Guid.NewGuid().ToString("N");
        var logger = _factory.Services.GetRequiredService<ILogger<LoggingEndpointTests>>();

        using (logger.BeginScope(new Dictionary<string, object>
               {
                   [LogPropertyNames.ReleaseId] = "shared-release",
                   [LogPropertyNames.StreamTokenFingerprint] = LogSanitizer.FingerprintToken(token),
               }))
        {
            logger.LogWarning("{Marker}", marker);
        }
        using (logger.BeginScope(new Dictionary<string, object>
               {
                   [LogPropertyNames.ReleaseId] = "shared-release",
                   [LogPropertyNames.StreamTokenFingerprint] = LogSanitizer.FingerprintToken(otherToken),
               }))
        {
            logger.LogWarning("{Marker}", otherMarker);
        }

        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();
        var feed = await admin.GetFromJsonAsync<LogFeedResponse>(
            $"/api/v1/logs?source=core&minimumLevel=warning&streamToken={token}");

        Assert.NotNull(feed);
        Assert.Contains(feed.Entries, entry => entry.Message.Contains(marker, StringComparison.Ordinal));
        Assert.DoesNotContain(feed.Entries, entry => entry.Message.Contains(otherMarker, StringComparison.Ordinal));
    }

    [Fact]
    public async Task HealthPollingAndOrdinaryFourHundredDoNotFillFeed_ButRateLimitDoes()
    {
        // Use a private host for this test: exhausting its fixed login window must not
        // make the class fixture's other concurrently-running admin logins flaky.
        using var rateFactory = new AuthEndpointTests.Factory();
        using var admin = rateFactory.CreateClient();
        await admin.AuthenticateAsAdminAsync();

        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/health")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/v1/logs?source=core")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/api/v1/not-a-real-endpoint")).StatusCode);

        using var loginClient = rateFactory.CreateClient();
        HttpStatusCode? loginStatus = null;
        for (var attempt = 0; attempt < 10 && loginStatus != HttpStatusCode.TooManyRequests; attempt++)
        {
            loginStatus = (await loginClient.PostAsJsonAsync(
                "/api/v1/auth/login",
                new { username = "admin", password = "definitely-wrong" })).StatusCode;
        }
        Assert.Equal(HttpStatusCode.TooManyRequests, loginStatus);

        var health = await admin.GetFromJsonAsync<LogFeedResponse>(
            "/api/v1/logs?source=core&minimumLevel=information&search=HTTP%20GET%20%2Fapi%2Fv1%2Fhealth");
        Assert.NotNull(health);
        Assert.Empty(health.Entries);

        var polling = await admin.GetFromJsonAsync<LogFeedResponse>(
            "/api/v1/logs?source=core&minimumLevel=information&search=HTTP%20GET%20%2Fapi%2Fv1%2Flogs");
        Assert.NotNull(polling);
        Assert.Empty(polling.Entries);

        var missing = await admin.GetFromJsonAsync<LogFeedResponse>(
            "/api/v1/logs?source=core&minimumLevel=information&search=not-a-real-endpoint");
        Assert.NotNull(missing);
        Assert.Empty(missing.Entries);

        var rateLimited = await admin.GetFromJsonAsync<LogFeedResponse>(
            "/api/v1/logs?source=core&minimumLevel=warning&search=429");
        Assert.NotNull(rateLimited);
        Assert.Contains(rateLimited.Entries, entry =>
            entry.Level == "warning"
            && entry.Message.Contains("/api/v1/auth/login", StringComparison.Ordinal));
    }

    [Fact]
    public async Task InvalidFiltersReturnBadRequest()
    {
        using var admin = _factory.CreateClient();
        await admin.AuthenticateAsAdminAsync();

        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("/api/v1/logs?source=unknown")).StatusCode);
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("/api/v1/logs?minimumLevel=noisy")).StatusCode);
    }
}
