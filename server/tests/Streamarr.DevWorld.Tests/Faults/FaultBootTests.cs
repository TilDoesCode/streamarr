using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Tests.Faults;

/// <summary>Real Core Server with the fault layer: API, auth and scoping faults over HTTP (media faults run live in tools/faults_smoke.py).</summary>
public class FaultBootTests(FakeWorld world) : IClassFixture<FakeWorld>
{
    private static readonly object Device = new
    {
        platform = "web",
        vlcAvailable = false,
        engines = new[] { new { engine = "web", hls = true, containers = new[] { "mp4" }, videoCodecs = new[] { new { codec = "h264" } }, audioCodecs = new[] { new { codec = "aac" } } } },
    };

    [Fact]
    public async Task Faults_ArmListScopeAndClear_OverTheRealServer()
    {
        var ct = CancellationToken.None;
        await using var booted = await BootAsync(faults: true, ct);
        using var http = new HttpClient { BaseAddress = new Uri(booted.Options.LocalUrl) };
        var anna = await LoginAsync(http, "anna", ct);
        var kind = await LoginAsync(http, "kind", ct);
        var workId = world.Plan.Releases.First(r => r.MediaType == "movie").WorkId;

        // api_status for anna's next start: once, with the product envelope and the fault header.
        var id = await ArmAsync(http, new { fault = "api_status", scope = new { next = "anna" }, target = "api:start", @params = new { status = 409, code = "too_many_streams", @params = new { device = "Wohnzimmer-TV", limit = "1" } } }, ct);
        using (var start = await SendAsync(http, HttpMethod.Post, "/api/v1/viewer/playback", anna, new { workId, device = Device, preferences = new { } }, ct))
        {
            Assert.Equal(HttpStatusCode.Conflict, start.StatusCode);
            Assert.Equal(id, Assert.Single(start.Headers.GetValues("X-DevWorld-Fault")));
            using var body = JsonDocument.Parse(await start.Content.ReadAsStringAsync(ct));
            Assert.Equal("too_many_streams", body.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal("Wohnzimmer-TV", body.RootElement.GetProperty("error").GetProperty("params").GetProperty("device").GetString());
        }
        using (var again = await SendAsync(http, HttpMethod.Post, "/api/v1/viewer/playback", anna, new { workId, device = Device, preferences = new { } }, ct))
        {
            Assert.Equal(HttpStatusCode.Accepted, again.StatusCode);
            Assert.False(again.Headers.Contains("X-DevWorld-Fault"));
        }

        // The start answer taught the playback map who plays what.
        var playbacks = await http.GetFromJsonAsync<JsonElement>("/devworld/playbacks", ct);
        Assert.Contains(playbacks.EnumerateArray(), p => p.GetProperty("viewer").GetString() == "anna" && p.GetProperty("workId").GetString() == workId);

        // captive_portal for kind only.
        await ArmAsync(http, new { fault = "captive_portal", scope = new { viewer = "kind" }, mode = "always" }, ct);
        using (var portal = await SendAsync(http, HttpMethod.Get, "/api/v1/viewer/me", kind, null, ct))
        {
            Assert.Equal("text/html", portal.Content.Headers.ContentType?.MediaType);
            Assert.Contains("Hotel Wi-Fi", await portal.Content.ReadAsStringAsync(ct));
        }
        using (var normal = await SendAsync(http, HttpMethod.Get, "/api/v1/viewer/me", anna, null, ct))
            Assert.Equal("application/json", normal.Content.Headers.ContentType?.MediaType);

        // list, get, clear by scope, clear all.
        var listed = await http.GetFromJsonAsync<JsonElement>("/devworld/faults", ct);
        Assert.Equal(2, listed.GetArrayLength());
        var one = await http.GetFromJsonAsync<JsonElement>($"/devworld/faults/{id}", ct);
        Assert.Equal(0, one.GetProperty("fault").GetProperty("remaining").GetInt32());
        Assert.Equal(1, one.GetProperty("lastHits").GetArrayLength());
        Assert.Equal(HttpStatusCode.NoContent, (await http.DeleteAsync("/devworld/faults?scope=viewer:kind", ct)).StatusCode);
        Assert.Equal(1, (await http.GetFromJsonAsync<JsonElement>("/devworld/faults", ct)).GetArrayLength());
        Assert.Equal(HttpStatusCode.NoContent, (await http.DeleteAsync($"/devworld/faults/{id}", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.DeleteAsync($"/devworld/faults/{id}", ct)).StatusCode);

        // Auth faults act on the session store.
        await ArmAsync(http, new { fault = "password_change", scope = new { viewer = "kind" } }, ct);
        using (var blocked = await SendAsync(http, HttpMethod.Post, "/api/v1/viewer/playback", kind, new { workId, device = Device, preferences = new { } }, ct))
            Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        await ArmAsync(http, new { fault = "token_expire", scope = new { viewer = "anna" } }, ct);
        using (var expired = await SendAsync(http, HttpMethod.Get, "/api/v1/viewer/me", anna, null, ct))
            Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);

        // Invalid requests and global exclusivity.
        using var invalid = await http.PostAsJsonAsync("/devworld/faults", new { fault = "seg_status", scope = new { } }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        await ArmAsync(http, new { fault = "seg_delay", scope = new { global = true }, @params = new { ms = 1 } }, ct);
        using var second = await http.PostAsJsonAsync("/devworld/faults", new { fault = "api_drop", scope = new { global = true }, target = "api:poll" }, ct);
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await http.DeleteAsync("/devworld/faults", ct)).StatusCode);
        Assert.Equal(0, (await http.GetFromJsonAsync<JsonElement>("/devworld/faults", ct)).GetArrayLength());
    }

    [Fact]
    public async Task Faults_Off_RegistersNothing()
    {
        var ct = CancellationToken.None;
        await using var booted = await BootAsync(faults: false, ct);
        using var http = new HttpClient { BaseAddress = new Uri(booted.Options.LocalUrl) };
        Assert.NotEqual(HttpStatusCode.OK, (await http.GetAsync("/devworld/faults", ct)).StatusCode);
        using var arm = await http.PostAsJsonAsync("/devworld/faults", new { fault = "seg_delay", scope = new { global = true }, @params = new { ms = 1 } }, ct);
        Assert.NotEqual(HttpStatusCode.Created, arm.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/devworld/ready", ct)).StatusCode);
    }

    private static async Task<string> ArmAsync(HttpClient http, object body, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync("/devworld/faults", body, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        Assert.True(response.StatusCode == HttpStatusCode.Created, text);
        return JsonDocument.Parse(text).RootElement.GetProperty("id").GetString()!;
    }

    private static async Task<string> LoginAsync(HttpClient http, string user, CancellationToken ct)
    {
        using var response = await http.PostAsJsonAsync("/api/v1/viewer/auth/login",
            new { login = user, password = WorldSeeder.ViewerPassword, deviceName = "fault-tests", clientName = "fault-tests" }, ct);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return body.RootElement.GetProperty("session").GetProperty("accessToken").GetString()!;
    }

    private static Task<HttpResponseMessage> SendAsync(HttpClient http, HttpMethod method, string path, string token, object? body, CancellationToken ct)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        if (body is not null)
            request.Content = JsonContent.Create(body);
        return http.SendAsync(request, ct);
    }

    private async Task<Booted> BootAsync(bool faults, CancellationToken ct)
    {
        var port = FreePort();
        var options = new DevWorldOptions
        {
            Port = port,
            Host = "127.0.0.1",
            CacheDir = world.Root,
            StateDir = Path.Combine(world.Root, $"state-{port}"),
            CatalogPath = FakeWorld.CatalogPath,
            Faults = faults,
        };
        Directory.CreateDirectory(options.StateDir);
        var nntp = DevWorldHost.CreateNntp(world.Store);
        var state = new DevWorldState();
        var app = DevWorldHost.Build(options, world.Plan, world.Store, nntp, state, []);
        var booted = new Booted(app, nntp, options);
        try
        {
            await app.StartAsync(ct);
            await WorldSeeder.SeedViewersAsync(app.Services, ct);
            state.MarkReady("{}");
            return booted;
        }
        catch
        {
            await booted.DisposeAsync();
            throw;
        }
    }

    private sealed class Booted(WebApplication app, MockNntpServer nntp, DevWorldOptions options) : IAsyncDisposable
    {
        public DevWorldOptions Options => options;

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
            await nntp.DisposeAsync();
        }
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
