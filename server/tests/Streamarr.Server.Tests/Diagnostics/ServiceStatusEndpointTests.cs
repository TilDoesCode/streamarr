using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Services;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Diagnostics host whose Pushover API is a recorder, so outage notifications can be asserted end to end.</summary>
public class ServiceStatusFactory : DiagnosticsFactory
{
    public ConcurrentQueue<string> PushoverBodies { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
            services.AddHttpClient<PushoverClient>().ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(PushoverBodies)));
    }

    private sealed class RecordingHandler(ConcurrentQueue<string> bodies) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            bodies.Enqueue(WebUtility.UrlDecode(await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"status":1,"request":"r"}""", Encoding.UTF8, "application/json"),
            };
        }
    }
}

/// <summary>The refresher runs on its own right after startup.</summary>
public sealed class ServiceStatusRefresherFactory : ServiceStatusFactory
{
    protected override void Configure(Dictionary<string, string?> settings)
    {
        settings["Streamarr:Diagnostics:StatusRefreshSeconds"] = "60";
        settings["Streamarr:Diagnostics:StatusStartupDelaySeconds"] = "0";
    }
}

public sealed class ServiceStatusEndpointTests(ServiceStatusFactory factory) : IClassFixture<ServiceStatusFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private void SkipRefreshThrottle() => factory.Clock.Advance(DeepHealthDiagnostics.MinRefreshInterval + TimeSpan.FromSeconds(1));

    [Fact]
    public async Task Status_ReportsCategoriesAndImpacts_WithoutNamesHostsOrErrors()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        SkipRefreshThrottle();
        Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true")).StatusCode);

        var response = await viewer.GetAsync("/api/v1/viewer/diagnostics/status");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        var status = JsonSerializer.Deserialize<ServiceStatusResponse>(raw, Json)!;

        foreach (var secret in new[] { "Good Indexer", "Wrong Key", "ok.example", "auth.example", "Main Provider", "Wrong Password", "127.0.0.1", "481", "Incorrect user", "auth_failed", "Provider 1", "Indexer 1" })
            Assert.DoesNotContain(secret, raw, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("degraded", status.State);
        var usenet = status.Categories.Single(c => c.Id == "usenet");
        Assert.Equal(("degraded", 1, 2), (usenet.State, usenet.Affected, usenet.Total));
        Assert.Equal("degraded", status.Categories.Single(c => c.Id == "search").State);
        Assert.Equal(["playbackMayFail", "searchMayBeIncomplete"], status.Impacts);
        Assert.NotNull(status.Since);
        Assert.NotNull(usenet.Since);
    }

    [Fact]
    public async Task Status_ReusesTheLastCheck_AndReportRefreshesFeedIt()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        SkipRefreshThrottle();
        await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true");

        var first = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        factory.Clock.Advance(TimeSpan.FromSeconds(15));
        var second = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        Assert.Equal(first!.CheckedAt, second!.CheckedAt);

        await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true");
        var third = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        Assert.True(third!.CheckedAt > first.CheckedAt);
        Assert.Equal(first.Since, third.Since);
    }

    [Fact]
    public async Task Status_RequiresAViewer()
    {
        await factory.SeedAsync();
        using var anon = factory.CreateClient();
        using var admin = await factory.AdminAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/viewer/diagnostics/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await admin.GetAsync("/api/v1/viewer/diagnostics/status")).StatusCode);
    }

    [Fact]
    public async Task Status_IsRateLimitedPerUser()
    {
        await factory.SeedAsync();
        using var admin = await factory.AdminAsync();
        await ViewerApi.CreateAsync(admin, new { username = "status-poller", password = DiagnosticsFactory.ViewerPassword });
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(await ViewerApi.AccessTokenAsync(anon, "status-poller", DiagnosticsFactory.ViewerPassword));

        for (var i = 0; i < DiagnosticsRateLimits.StatusPerMinute; i++)
            Assert.Equal(HttpStatusCode.OK, (await viewer.GetAsync("/api/v1/viewer/diagnostics/status")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await viewer.GetAsync("/api/v1/viewer/diagnostics/status")).StatusCode);
    }

}

/// <summary>Own fixture: no earlier check may have started the debounce.</summary>
public sealed class ServiceStatusNotificationTests(ServiceStatusFactory factory) : IClassFixture<ServiceStatusFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private void SkipRefreshThrottle() => factory.Clock.Advance(DeepHealthDiagnostics.MinRefreshInterval + TimeSpan.FromSeconds(1));

    [Fact]
    public async Task AdminNotified_FollowsTheOptIn_AndTheOutageIsSentOnceAfterTwoChecks()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        using var admin = await factory.AdminAsync();
        var tracker = factory.Services.GetRequiredService<ServiceStatusTracker>();
        var before = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        Assert.False(before!.AdminNotified);
        for (var i = 0; i < 3; i++)
        {
            SkipRefreshThrottle();
            await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true");
        }
        Assert.False(tracker.OutageAnnounced);

        var saved = await admin.PutAsJsonAsync("/api/v1/config/notifications", new
        {
            enabled = true, appToken = "app-token-123", userKey = "user-key-456", notifyServiceStatus = true,
            progressIntervalMinutes = 30, monitorIntervalSeconds = 3600, outageFailureThreshold = 100,
            emergencyRetrySeconds = 60, emergencyExpireSeconds = 3600,
        });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
        Assert.True((await saved.Content.ReadFromJsonAsync<NotificationConfigResponse>(Json))!.NotifyServiceStatus);

        var after = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        Assert.True(after!.AdminNotified);

        Assert.False(tracker.OutageAnnounced);
        for (var i = 0; i < 3; i++)
        {
            SkipRefreshThrottle();
            await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true");
        }
        Assert.True(tracker.OutageAnnounced);

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!factory.PushoverBodies.Any(b => b.Contains("Streamarr service")) && DateTime.UtcNow < deadline)
            await Task.Delay(50);
        await Task.Delay(200);
        var message = Assert.Single(factory.PushoverBodies, b => b.Contains("Streamarr service"));
        Assert.Contains("title=Streamarr service degraded", message);
        Assert.Contains("Wrong Password Provider", message);
    }
}

public sealed class ServiceStatusRefresherTests(ServiceStatusRefresherFactory factory) : IClassFixture<ServiceStatusRefresherFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Refresher_ChecksWithoutAnyRequest_AndStatusCallsDoNotProbe()
    {
        var token = await factory.SeedAsync();
        var tracker = factory.Services.GetRequiredService<ServiceStatusTracker>();
        var refresher = factory.Services.GetRequiredService<ServiceStatusRefresher>();
        Assert.Equal(60, refresher.IntervalSeconds);

        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (tracker.Current is null && DateTime.UtcNow < deadline)
            await Task.Delay(50);
        Assert.NotNull(tracker.Current);

        using var viewer = factory.Viewer(token);
        var first = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        factory.Clock.Advance(TimeSpan.FromSeconds(90));
        var second = await viewer.GetFromJsonAsync<ServiceStatusResponse>("/api/v1/viewer/diagnostics/status", Json);
        Assert.Equal(first!.CheckedAt, second!.CheckedAt);
    }

    [Fact]
    public async Task Refresher_StopsCleanly()
    {
        await factory.SeedAsync();
        var refresher = factory.Services.GetRequiredService<ServiceStatusRefresher>();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await refresher.StopAsync(cts.Token);
        Assert.False(cts.IsCancellationRequested);
    }
}
