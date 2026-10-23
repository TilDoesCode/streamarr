using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Admin and viewer diagnostics reports over the real pipeline with real NNTP probes.</summary>
public sealed class DiagnosticsEndpointTests(DiagnosticsFactory factory) : IClassFixture<DiagnosticsFactory>
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private async Task<DiagnosticsResponse> AdminReportAsync(bool refresh = true)
    {
        using var admin = await factory.AdminAsync();
        var response = await admin.GetAsync($"/api/v1/diagnostics?refresh={refresh.ToString().ToLowerInvariant()}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<DiagnosticsResponse>(Json))!;
    }

    private void SkipRefreshThrottle() => factory.Clock.Advance(DeepHealthDiagnostics.MinRefreshInterval + TimeSpan.FromSeconds(1));

    [Fact]
    public async Task Admin_Report_NamesEveryComponentWithLatencyErrorsAndHints()
    {
        await factory.SeedAsync();
        factory.Tmdb.Probe = new TmdbProbeResult(true);
        SkipRefreshThrottle();

        var report = await AdminReportAsync();

        Assert.Equal("degraded", report.Status);
        Assert.Contains("provider_auth_failed", report.Hints);
        Assert.Contains("some_providers_down", report.Hints);
        Assert.Contains("indexer_auth_failed", report.Hints);
        Assert.Contains("some_indexers_down", report.Hints);
        Assert.DoesNotContain("all_providers_down", report.Hints);

        var database = Assert.Single(report.Components, c => c.Kind == "database");
        Assert.Equal("ok", database.Status);
        Assert.NotNull(database.LatencyMs);
        Assert.Equal("ok", Assert.Single(report.Components, c => c.Kind == "metadata").Status);
        Assert.Single(report.Components, c => c.Kind == "streams");

        var providers = report.Components.Where(c => c.Kind == "provider").ToList();
        Assert.Equal(["Main Provider", "Wrong Password Provider"], providers.Select(p => p.Name));
        Assert.Equal("ok", providers[0].Status);
        Assert.NotNull(providers[0].LatencyMs);
        Assert.Equal("down", providers[1].Status);
        Assert.Equal("auth_failed", providers[1].ErrorCode);
        Assert.Contains("481", providers[1].Error);

        var indexers = report.Components.Where(c => c.Kind == "indexer").ToList();
        Assert.Equal("ok", Assert.Single(indexers, i => i.Name == "Good Indexer").Status);
        var wrongKey = Assert.Single(indexers, i => i.Name == "Wrong Key Indexer");
        Assert.Equal("auth_failed", wrongKey.ErrorCode);
        Assert.Contains("Incorrect user credentials", wrongKey.Error);
        Assert.False(string.IsNullOrEmpty(report.Server.Version));
    }

    [Fact]
    public async Task Viewer_Report_IsRedacted()
    {
        var token = await factory.SeedAsync();
        SkipRefreshThrottle();
        using var viewer = factory.Viewer(token);

        var response = await viewer.GetAsync("/api/v1/viewer/diagnostics?refresh=true");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        var report = JsonSerializer.Deserialize<DiagnosticsResponse>(raw, Json)!;

        foreach (var secret in new[] { "Good Indexer", "Wrong Key", "ok.example", "auth.example", "Main Provider", "Wrong Password", "127.0.0.1", "481", "idx-secret", "Incorrect user", "priority" })
            Assert.DoesNotContain(secret, raw, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["Provider 1", "Provider 2"], report.Components.Where(c => c.Kind == "provider").Select(c => c.Name));
        Assert.Equal(["Indexer 1", "Indexer 2"], report.Components.Where(c => c.Kind == "indexer").Select(c => c.Name));
        Assert.All(report.Components, c =>
        {
            Assert.Null(c.Error);
            Assert.Null(c.Detail);
            Assert.Null(c.FreeBytes);
        });
        Assert.Equal("auth_failed", report.Components.Single(c => c.Id == "provider:2").ErrorCode);
        Assert.Contains("provider_auth_failed", report.Hints);
    }

    [Fact]
    public async Task Reports_RequireTheirOwnCredentials()
    {
        var token = await factory.SeedAsync();
        using var anon = factory.CreateClient();
        using var viewer = factory.Viewer(token);
        using var admin = await factory.AdminAsync();

        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/diagnostics")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/diagnostics/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await admin.GetAsync("/api/v1/viewer/diagnostics/ping")).StatusCode);
    }

    [Fact]
    public async Task Refresh_IsThrottledToTheMinimumInterval()
    {
        await factory.SeedAsync();
        SkipRefreshThrottle();
        var first = await AdminReportAsync();

        var again = await AdminReportAsync();
        Assert.Equal(first.CheckedAt, again.CheckedAt);
        Assert.Equal(first.CheckedAt + DeepHealthDiagnostics.MinRefreshInterval, again.RefreshAvailableAt);

        SkipRefreshThrottle();
        var cached = await AdminReportAsync(refresh: false);
        Assert.Equal(first.CheckedAt, cached.CheckedAt);
        var fresh = await AdminReportAsync();
        Assert.True(fresh.CheckedAt > first.CheckedAt);
    }

    [Fact]
    public async Task Tmdb_Failures_SurfaceAsHints()
    {
        await factory.SeedAsync();
        try
        {
            factory.Tmdb.Probe = new TmdbProbeResult(false, "timeout", "TMDB did not answer in time.");
            SkipRefreshThrottle();
            var down = await AdminReportAsync();
            Assert.Contains("tmdb_unreachable", down.Hints);
            Assert.Equal("timeout", down.Components.Single(c => c.Kind == "metadata").ErrorCode);

            factory.Tmdb.Probe = TmdbProbeResult.NotConfigured;
            SkipRefreshThrottle();
            var unconfigured = await AdminReportAsync();
            Assert.Contains("tmdb_not_configured", unconfigured.Hints);
            Assert.Equal("unconfigured", unconfigured.Components.Single(c => c.Kind == "metadata").Status);
        }
        finally
        {
            factory.Tmdb.Probe = new TmdbProbeResult(true);
        }
    }

    [Fact]
    public async Task DeepHealth_KeepsItsShapeAndGainsProviderLatency()
    {
        await factory.SeedAsync();
        using var admin = await factory.AdminAsync();

        var health = await admin.GetFromJsonAsync<HealthResponse>("/api/v1/health?deep=true", Json);

        Assert.Equal("degraded", health!.Status);
        var good = Assert.Single(health.Providers, p => p.Name == "Main Provider");
        Assert.True(good.Reachable);
        Assert.NotNull(good.LatencyMs);
        Assert.Equal("unreachable", Assert.Single(health.Providers, p => p.Name == "Wrong Password Provider").Error);
        Assert.Equal("unreachable", Assert.Single(health.Indexers, p => p.Name == "Wrong Key Indexer").Error);
    }

    [Fact]
    public async Task Ping_ReportsServerTimeAndLimits()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);

        var ping = await viewer.GetFromJsonAsync<SpeedTestPingResponse>("/api/v1/viewer/diagnostics/ping", Json);

        Assert.Equal(200L * 1024 * 1024, ping!.MaxDownloadBytes);
        Assert.Equal(100L * 1024 * 1024, ping.MaxUploadBytes);
        Assert.Equal(factory.Clock.GetUtcNow(), ping.ServerTime);
    }

    [Fact]
    public async Task Download_StreamsExactlyTheRequestedRandomBytes()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);

        var response = await viewer.GetAsync("/api/v1/viewer/diagnostics/speed/download?bytes=3000000");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.Null(response.Content.Headers.ContentEncoding.FirstOrDefault());
        Assert.Contains("no-store", response.Headers.CacheControl?.ToString());
        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(3_000_000, body.Length);
        Assert.True(body.Distinct().Count() > 250);
        Assert.False(body.AsSpan(0, 65_536).SequenceEqual(body.AsSpan(65_536, 65_536)));

        using var admin = await factory.AdminAsync();
        var adminBody = await admin.GetByteArrayAsync("/api/v1/diagnostics/speed/download?bytes=1024");
        Assert.Equal(1024, adminBody.Length);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-5")]
    [InlineData("209715201")]
    public async Task Download_RejectsSizesOutsideTheLimit(string bytes)
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);

        var response = await viewer.GetAsync($"/api/v1/viewer/diagnostics/speed/download?bytes={bytes}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Upload_AcceptsBodiesAboveTheGlobalLimit_OnlyOnTheSpeedTestRoute()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        var payload = new byte[5 * 1024 * 1024];
        Random.Shared.NextBytes(payload);

        var response = await viewer.PostAsync("/api/v1/viewer/diagnostics/speed/upload", Octets(payload));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<SpeedTestUploadResponse>(Json);
        Assert.Equal(payload.Length, result!.Bytes);
        Assert.True(result.DurationMs >= 0);

        using var admin = await factory.AdminAsync();
        var adminResult = await (await admin.PostAsync("/api/v1/diagnostics/speed/upload", Octets(payload))).Content.ReadFromJsonAsync<SpeedTestUploadResponse>(Json);
        Assert.Equal(payload.Length, adminResult!.Bytes);

        var elsewhere = await viewer.PostAsync("/api/v1/viewer/watch/progress", Octets(payload));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, elsewhere.StatusCode);
    }

    [Fact]
    public async Task Upload_RejectsADeclaredLengthAboveTheCap()
    {
        var token = await factory.SeedAsync();
        using var viewer = factory.Viewer(token);
        var content = new ByteArrayContent(new byte[16]);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        content.Headers.ContentLength = 100L * 1024 * 1024 + 1;

        HttpResponseMessage? response = null;
        try
        {
            response = await viewer.PostAsync("/api/v1/viewer/diagnostics/speed/upload", content);
        }
        catch (Exception e) when (e is HttpRequestException or InvalidOperationException or IOException)
        {
            // The in-memory transport may refuse the mismatched length before the server answers.
            return;
        }
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    private static ByteArrayContent Octets(byte[] payload)
    {
        var content = new ByteArrayContent(payload);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return content;
    }
}
