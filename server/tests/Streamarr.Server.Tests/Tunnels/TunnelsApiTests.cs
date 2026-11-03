using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>
/// /api/v1/tunnels over the real DB-backed services: CRUD with write-only keys, import, presets, status, delete
/// protection, and the fail-closed route on providers and indexers while no helper runs.
/// </summary>
public sealed class TunnelsApiTests : IClassFixture<TunnelsApiTests.Factory>
{
    private const string ApiKey = "tunnel-test-api-key-aaaaaaaaaaaaaaaa";
    private const string PrivateKey = TunnelValidationTests.PrivateKey;
    private const string PublicKey = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
    private const string PeerKey = TunnelValidationTests.PeerKey;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Factory _factory;

    public TunnelsApiTests(Factory factory) => _factory = factory;

    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.AuthenticateAsAdminAsync().GetAwaiter().GetResult();
        return client;
    }

    private static object ValidTunnel(string name = "Mullvad SE", bool enabled = true) => new
    {
        name,
        preset = "mullvad",
        enabled,
        privateKey = PrivateKey,
        peerPublicKey = PeerKey,
        endpoint = "185.65.134.86:51820",
        addresses = new[] { "10.64.12.3/32" },
    };

    private static async Task<TunnelResponse> CreateTunnel(HttpClient client, string name = "Mullvad SE", bool enabled = true)
    {
        var response = await client.PostAsJsonAsync("/api/v1/tunnels", ValidTunnel(name, enabled));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TunnelResponse>(Json))!;
    }

    [Fact]
    public async Task Create_ReturnsDerivedPublicKey_NeverTheSecrets_AndIsDownWithoutHelper()
    {
        using var client = Client();

        var response = await client.PostAsJsonAsync("/api/v1/tunnels", new
        {
            name = "Mullvad SE",
            preset = "mullvad",
            privateKey = PrivateKey,
            presharedKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=",
            peerPublicKey = PeerKey,
            endpoint = "185.65.134.86:51820",
            addresses = new[] { "10.64.12.3/32", "fc00:bbbb:bbbb:bb01::1:c02" },
            keepalive = 25,
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(PrivateKey, raw);
        Assert.DoesNotContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=", raw);
        Assert.DoesNotContain("privateKey", raw);

        var created = JsonSerializer.Deserialize<TunnelResponse>(raw, Json)!;
        Assert.Equal("mullvad", created.Preset);
        Assert.True(created.Enabled);
        Assert.True(created.HasPrivateKey);
        Assert.True(created.HasPresharedKey);
        Assert.Equal(PublicKey, created.PublicKey);
        Assert.Equal(PeerKey, created.PeerPublicKey);
        Assert.Equal(["10.64.12.3/32", "fc00:bbbb:bbbb:bb01::1:c02/128"], created.Addresses);
        Assert.Equal(["10.64.0.1"], created.Dns);
        Assert.Equal(["0.0.0.0/0", "::/0"], created.AllowedIps);
        Assert.Equal(25, created.Keepalive);
        Assert.Equal(TunnelStates.Down, created.Status.State);
        Assert.Equal(TunnelSupervisor.DisabledByOptionsError, created.Status.LastError);
        Assert.Empty(created.UsedBy.Providers);
        Assert.Equal($"http://localhost/api/v1/tunnels/{created.Id}", response.Headers.Location!.ToString(), ignoreCase: true);

        var listRaw = await client.GetStringAsync("/api/v1/tunnels");
        Assert.DoesNotContain(PrivateKey, listRaw);
        var list = JsonSerializer.Deserialize<List<TunnelResponse>>(listRaw, Json)!;
        Assert.Contains(list, t => t.Id == created.Id);

        var fetched = await client.GetFromJsonAsync<TunnelResponse>($"/api/v1/tunnels/{created.Id}", Json);
        Assert.Equal(created.PublicKey, fetched!.PublicKey);

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/tunnels/{created.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v1/tunnels/{created.Id}")).StatusCode);
    }

    [Fact]
    public async Task Create_ValidationErrors_ArePerField()
    {
        using var client = Client();
        var response = await client.PostAsJsonAsync("/api/v1/tunnels", new
        {
            name = "Broken",
            preset = "custom",
            privateKey = "short",
            peerPublicKey = PeerKey,
            endpoint = "no port but bad host",
            addresses = new[] { "10.0.0.2" },
        });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
        Assert.Equal("invalid_tunnel", error.GetProperty("code").GetString());
        var fields = error.GetProperty("params").EnumerateObject().Select(p => p.Name).ToList();
        Assert.Contains("privateKey", fields);
        Assert.Contains("dns", fields);
        Assert.Contains("endpoint", fields);
        Assert.StartsWith("'privateKey':", error.GetProperty("message").GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/tunnels", new { preset = "mullvad" })).StatusCode);
    }

    [Fact]
    public async Task Update_KeepsPrivateKeyWhenOmitted_ClearsPresharedKeyWithEmptyString()
    {
        using var client = Client();
        var created = await CreateTunnel(client, "Rotate");
        var withPsk = await client.PutAsJsonAsync($"/api/v1/tunnels/{created.Id}", new
        {
            name = "Rotate",
            preset = "mullvad",
            presharedKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=",
            peerPublicKey = PeerKey,
            endpoint = "185.65.134.86:51820",
            addresses = new[] { "10.64.12.3/32" },
        });
        Assert.Equal(HttpStatusCode.OK, withPsk.StatusCode);
        var updated = (await withPsk.Content.ReadFromJsonAsync<TunnelResponse>(Json))!;
        Assert.True(updated.HasPrivateKey);
        Assert.Equal(PublicKey, updated.PublicKey);
        Assert.True(updated.HasPresharedKey);

        var cleared = await client.PutAsJsonAsync($"/api/v1/tunnels/{created.Id}", new
        {
            name = "Rotated",
            preset = "mullvad",
            enabled = false,
            presharedKey = "",
            peerPublicKey = PeerKey,
            endpoint = "185.65.134.86:51820",
            addresses = new[] { "10.64.12.3/32" },
        });
        var disabled = (await cleared.Content.ReadFromJsonAsync<TunnelResponse>(Json))!;
        Assert.False(disabled.HasPresharedKey);
        Assert.False(disabled.Enabled);
        Assert.Equal("Rotated", disabled.Name);
        Assert.Equal(TunnelStates.Disabled, disabled.Status.State);
        Assert.Null(disabled.Status.LastError);

        var status = await client.GetFromJsonAsync<TunnelStatusListResponse>("/api/v1/tunnels/status", Json);
        var entry = Assert.Single(status!.Tunnels, t => t.Id == created.Id);
        Assert.False(entry.Enabled);
        Assert.Equal(TunnelStates.Disabled, entry.Status.State);

        Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsJsonAsync("/api/v1/tunnels/missing", ValidTunnel())).StatusCode);
        await client.DeleteAsync($"/api/v1/tunnels/{created.Id}");
    }

    [Fact]
    public async Task Import_PrefillsFromConf_AndReportsProblems()
    {
        using var client = Client();
        var text = """
            [Interface]
            PrivateKey = dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=
            Address = 10.2.0.2/32
            DNS = 10.2.0.1

            [Peer]
            PublicKey = 3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=
            AllowedIPs = 0.0.0.0/0
            Endpoint = node-ch-01.protonvpn.net:51820
            """;
        var response = await client.PostAsJsonAsync("/api/v1/tunnels/import", new { text });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var import = (await response.Content.ReadFromJsonAsync<TunnelImportResponse>(Json))!;
        Assert.True(import.Valid);
        Assert.Equal("protonvpn", import.DetectedPreset);
        Assert.Equal(PrivateKey, import.Tunnel.PrivateKey);
        Assert.Equal("node-ch-01.protonvpn.net:51820", import.Tunnel.Endpoint);

        var saved = await client.PostAsJsonAsync("/api/v1/tunnels", import.Tunnel with { Name = "Proton CH" });
        Assert.Equal(HttpStatusCode.Created, saved.StatusCode);
        var tunnel = (await saved.Content.ReadFromJsonAsync<TunnelResponse>(Json))!;
        Assert.Equal("protonvpn", tunnel.Preset);
        Assert.Equal(["10.2.0.1"], tunnel.Dns);
        await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}");

        var broken = await client.PostAsJsonAsync("/api/v1/tunnels/import", new { text = "[Peer]\nEndpoint = x:1" });
        var problems = (await broken.Content.ReadFromJsonAsync<TunnelImportResponse>(Json))!;
        Assert.False(problems.Valid);
        Assert.Contains(problems.Errors, e => e.Field == "interface");
        Assert.Contains(problems.Errors, e => e.Field == "privateKey");

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/tunnels/import", new { })).StatusCode);
    }

    [Fact]
    public async Task Presets_ListTheCatalogWithCustomLast()
    {
        using var client = Client();
        var presets = await client.GetFromJsonAsync<List<TunnelPresetResponse>>("/api/v1/tunnels/presets", Json);
        Assert.Equal(["mullvad", "protonvpn", "nordvpn", "surfshark", "pia", "airvpn", "windscribe", "ivpn", "custom"], presets!.Select(p => p.Id));
        var mullvad = presets!.Single(p => p.Id == "mullvad");
        Assert.Equal("https://am.i.mullvad.net/json", mullvad.ExitIpCheckUrl);
        Assert.Equal(["10.64.0.1"], mullvad.DefaultDns);
        Assert.All(presets!, p => Assert.StartsWith("https://", p.HelpUrl));
    }

    [Fact]
    public async Task Provider_RoutedThroughTunnel_ShowsRoute_FailsTestClosed_AndBlocksDelete()
    {
        using var client = Client();
        var tunnel = await CreateTunnel(client, "Provider VPN");

        var unknown = await client.PostAsJsonAsync("/api/v1/config/providers", new { name = "bad", host = "news.example", tunnelId = "nope" });
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        Assert.Contains("tunnelId", (await unknown.Content.ReadAsStringAsync()));

        var create = await client.PostAsJsonAsync("/api/v1/config/providers", new
        {
            name = "Eweka", host = "news.eweka.nl", username = "u", password = "p", maxConnections = 4, tunnelId = tunnel.Id,
        });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var provider = await create.Content.ReadFromJsonAsync<JsonElement>();
        var providerId = provider.GetProperty("id").GetString()!;
        Assert.Equal(tunnel.Id, provider.GetProperty("tunnelId").GetString());
        var route = provider.GetProperty("route");
        Assert.Equal("tunnel", route.GetProperty("kind").GetString());
        Assert.Equal("Provider VPN", route.GetProperty("tunnelName").GetString());
        Assert.Equal("down", route.GetProperty("state").GetString());
        Assert.False(route.GetProperty("usable").GetBoolean());

        var test = await client.PostAsync($"/api/v1/config/providers/{providerId}/test", null);
        Assert.Equal(HttpStatusCode.OK, test.StatusCode);
        var result = await test.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(result.GetProperty("success").GetBoolean());
        Assert.Equal("vpn_down", result.GetProperty("errorCode").GetString());
        Assert.Equal(0, result.GetProperty("achievableConnections").GetInt32());
        Assert.Equal(4, result.GetProperty("requestedConnections").GetInt32());
        Assert.Contains("VPN down: tunnel 'Provider VPN' is down", result.GetProperty("error").GetString());
        Assert.Equal("tunnel", result.GetProperty("route").GetProperty("kind").GetString());

        var speed = await client.PostAsJsonAsync($"/api/v1/config/providers/{providerId}/speedtest", new { durationSeconds = 1 });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, speed.StatusCode);
        Assert.Equal("vpn_down", (await speed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString());

        var tunnelView = await client.GetFromJsonAsync<TunnelResponse>($"/api/v1/tunnels/{tunnel.Id}", Json);
        Assert.Equal(["Eweka"], tunnelView!.UsedBy.Providers.Select(p => p.Name));

        var refused = await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}");
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var conflict = (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error");
        Assert.Equal("tunnel_in_use", conflict.GetProperty("code").GetString());
        Assert.Contains("'Eweka'", conflict.GetProperty("message").GetString());
        Assert.Equal("Eweka", conflict.GetProperty("params").GetProperty("providers").GetString());
        var usedBy = conflict.GetProperty("usedBy");
        Assert.Equal(providerId, Assert.Single(usedBy.GetProperty("providers").EnumerateArray()).GetProperty("id").GetString());
        Assert.Equal("Eweka", Assert.Single(usedBy.GetProperty("providers").EnumerateArray()).GetProperty("name").GetString());
        Assert.Empty(usedBy.GetProperty("indexers").EnumerateArray());

        var listed = (await client.GetFromJsonAsync<JsonElement>("/api/v1/config/providers")).EnumerateArray().Single(p => p.GetProperty("id").GetString() == providerId);
        Assert.Equal("tunnel", listed.GetProperty("route").GetProperty("kind").GetString());

        // Switching back to direct with an empty tunnelId.
        var direct = await client.PutAsJsonAsync($"/api/v1/config/providers/{providerId}", new { name = "Eweka", host = "news.eweka.nl", tunnelId = "" });
        var directBody = await direct.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, directBody.GetProperty("tunnelId").ValueKind);
        Assert.Equal("direct", directBody.GetProperty("route").GetProperty("kind").GetString());
        Assert.True(directBody.GetProperty("route").GetProperty("usable").GetBoolean());

        // And back through the tunnel, then force-delete the tunnel.
        await client.PutAsJsonAsync($"/api/v1/config/providers/{providerId}", new { name = "Eweka", host = "news.eweka.nl", tunnelId = tunnel.Id });
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}?force=true")).StatusCode);
        var afterForce = await client.GetFromJsonAsync<JsonElement>($"/api/v1/config/providers/{providerId}");
        Assert.Equal(JsonValueKind.Null, afterForce.GetProperty("tunnelId").ValueKind);
        Assert.Equal("direct", afterForce.GetProperty("route").GetProperty("kind").GetString());

        await client.DeleteAsync($"/api/v1/config/providers/{providerId}");
    }

    [Fact]
    public async Task Indexer_RoutedThroughTunnel_FailsTestClosed_WhileDirectIndexerWorks()
    {
        using var client = Client();
        var tunnel = await CreateTunnel(client, "Indexer VPN");

        var routed = await client.PostAsJsonAsync("/api/v1/config/indexers", new { name = "Geek", baseUrl = "https://api.nzbgeek.info", apiKey = "k", tunnelId = tunnel.Id });
        Assert.Equal(HttpStatusCode.Created, routed.StatusCode);
        var routedBody = await routed.Content.ReadFromJsonAsync<JsonElement>();
        var routedId = routedBody.GetProperty("id").GetString()!;
        Assert.Equal("tunnel", routedBody.GetProperty("route").GetProperty("kind").GetString());
        Assert.False(routedBody.GetProperty("route").GetProperty("usable").GetBoolean());

        var direct = await client.PostAsJsonAsync("/api/v1/config/indexers", new { name = "Plain", baseUrl = "https://plain.example", apiKey = "k" });
        var directBody = await direct.Content.ReadFromJsonAsync<JsonElement>();
        var directId = directBody.GetProperty("id").GetString()!;
        Assert.Equal(JsonValueKind.Null, directBody.GetProperty("tunnelId").ValueKind);
        Assert.Equal("direct", directBody.GetProperty("route").GetProperty("kind").GetString());

        var blocked = await (await client.PostAsync($"/api/v1/config/indexers/{routedId}/test", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(blocked.GetProperty("success").GetBoolean());
        Assert.Equal("vpn_down", blocked.GetProperty("errorCode").GetString());
        Assert.Contains("Indexer VPN", blocked.GetProperty("error").GetString());

        var ok = await (await client.PostAsync($"/api/v1/config/indexers/{directId}/test", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(ok.GetProperty("success").GetBoolean());
        Assert.Equal("direct", ok.GetProperty("route").GetProperty("kind").GetString());

        var store = _factory.Services.GetRequiredService<Server.Config.IndexerConfigService>();
        Assert.Equal(tunnel.Id, store.GetAll().Single(i => i.Id == routedId).TunnelId);

        var unknown = await client.PutAsJsonAsync($"/api/v1/config/indexers/{directId}", new { name = "Plain", baseUrl = "https://plain.example", tunnelId = "missing" });
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);

        await client.DeleteAsync($"/api/v1/config/indexers/{routedId}");
        await client.DeleteAsync($"/api/v1/config/indexers/{directId}");
        await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}");
    }

    [Fact]
    public async Task Diagnostics_AndHealth_ReportTunnelDownAndRoutedDependenciesAsVpnDown()
    {
        using var client = Client();
        var tunnel = await CreateTunnel(client, "Diag VPN");
        var provider = await (await client.PostAsJsonAsync("/api/v1/config/providers", new { name = "Routed Provider", host = "news.example", tunnelId = tunnel.Id })).Content.ReadFromJsonAsync<JsonElement>();
        var indexer = await (await client.PostAsJsonAsync("/api/v1/config/indexers", new { name = "Routed Indexer", baseUrl = "https://routed.example", apiKey = "k", tunnelId = tunnel.Id })).Content.ReadFromJsonAsync<JsonElement>();

        var report = await client.GetFromJsonAsync<DiagnosticsResponse>("/api/v1/diagnostics?refresh=true", Json);
        Assert.Contains("tunnel_down", report!.Hints);
        Assert.Contains("all_providers_down", report.Hints);
        var hints = report.Hints.ToList();
        Assert.True(hints.IndexOf("tunnel_down") < hints.IndexOf("all_providers_down"));
        var tunnelComponent = Assert.Single(report.Components, c => c.Kind == "tunnel");
        Assert.Equal("Diag VPN", tunnelComponent.Name);
        Assert.Equal("down", tunnelComponent.Status);
        Assert.Equal("unreachable", tunnelComponent.ErrorCode);
        Assert.Equal(TunnelSupervisor.DisabledByOptionsError, tunnelComponent.Error);
        var providerComponent = Assert.Single(report.Components, c => c.Kind == "provider");
        Assert.Equal("down", providerComponent.Status);
        Assert.Equal("vpn_down", providerComponent.ErrorCode);
        Assert.Contains("VPN down", providerComponent.Error);
        var indexerComponent = Assert.Single(report.Components, c => c.Kind == "indexer");
        Assert.Equal("vpn_down", indexerComponent.ErrorCode);

        var health = await client.GetFromJsonAsync<HealthResponse>("/api/v1/health?deep=true", Json);
        Assert.Equal("degraded", health!.Status);
        var tunnelHealth = Assert.Single(health.Tunnels);
        Assert.Equal("Diag VPN", tunnelHealth.Name);
        Assert.False(tunnelHealth.Reachable);
        Assert.Contains("down", tunnelHealth.Error);
        Assert.Equal("VPN down", Assert.Single(health.Providers).Error);

        var metrics = await client.GetFromJsonAsync<MetricsResponse>("/api/v1/metrics", Json);
        var metric = Assert.Single(metrics!.Tunnels, t => t.Id == tunnel.Id);
        Assert.Equal("down", metric.State);
        Assert.Equal(1, metric.Providers);
        Assert.Equal(1, metric.Indexers);

        await client.DeleteAsync($"/api/v1/config/providers/{provider.GetProperty("id").GetString()}");
        await client.DeleteAsync($"/api/v1/config/indexers/{indexer.GetProperty("id").GetString()}");
        await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}");
    }

    [Fact]
    public async Task TunnelsApi_RequiresAdmin()
    {
        using var machine = _factory.CreateClient();
        machine.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/tunnels")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/api/v1/tunnels/presets")).StatusCode);

        using var anonymous = _factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/v1/tunnels/status")).StatusCode);
    }

    [Fact]
    public async Task Test_WithoutHelper_FailsClosed()
    {
        using var client = Client();
        var tunnel = await CreateTunnel(client, "Test VPN");
        var result = await (await client.PostAsync($"/api/v1/tunnels/{tunnel.Id}/test", null)).Content.ReadFromJsonAsync<TunnelTestResult>(Json);
        Assert.False(result!.Success);
        Assert.False(result.HandshakeOk);
        Assert.Equal(TunnelStates.Down, result.State);
        Assert.Equal(TunnelSupervisor.DisabledByOptionsError, result.Error);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/v1/tunnels/missing/test", null)).StatusCode);
        await client.DeleteAsync($"/api/v1/tunnels/{tunnel.Id}");
    }

    public sealed class Factory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-tunnels-api-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:ApiKey"] = ApiKey,
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
                ["Streamarr:PreDownload:CachePath"] = Path.Combine(_dir, "pre-download"),
                ["Streamarr:LoginAttemptsPerMinute"] = "1000",
                ["Streamarr:DeepHealthCacheSeconds"] = "1",
                ["Streamarr:Tunnels:Enabled"] = "false",
            }));
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<INewznabClient>();
                services.AddSingleton<INewznabClient>(new FakeCapsNewznabClient());
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }

    private sealed class FakeCapsNewznabClient : INewznabClient
    {
        public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
            => Task.FromResult(new NewznabCapabilities { ServerTitle = "MockIndexer", SearchAvailable = true });

        public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
            => Task.FromResult(new NewznabSearchResponse());
    }
}

/// <summary>With the legacy INDEXER_PROXY set, indexers without a tunnel report the external proxy route.</summary>
public sealed class TunnelsExternalProxyRouteTests : IClassFixture<TunnelsExternalProxyRouteTests.ProxyFactory>
{
    private readonly ProxyFactory _factory;

    public TunnelsExternalProxyRouteTests(ProxyFactory factory) => _factory = factory;

    [Fact]
    public async Task Indexer_WithoutTunnel_UsesExternalProxy_TunnelTakesPrecedence()
    {
        using var client = _factory.CreateClient();
        await client.AuthenticateAsAdminAsync();

        var plain = await (await client.PostAsJsonAsync("/api/v1/config/indexers", new { name = "Plain", baseUrl = "https://plain.example", apiKey = "k" })).Content.ReadFromJsonAsync<JsonElement>();
        var route = plain.GetProperty("route");
        Assert.Equal("externalProxy", route.GetProperty("kind").GetString());
        Assert.True(route.GetProperty("usable").GetBoolean());

        var tunnel = await (await client.PostAsJsonAsync("/api/v1/tunnels", new
        {
            name = "VPN", preset = "custom", privateKey = TunnelValidationTests.PrivateKey, peerPublicKey = TunnelValidationTests.PeerKey,
            endpoint = "vpn.example:51820", addresses = new[] { "10.0.0.2/32" }, dns = new[] { "10.0.0.1" },
        })).Content.ReadFromJsonAsync<JsonElement>();
        var routed = await (await client.PostAsJsonAsync("/api/v1/config/indexers", new { name = "Routed", baseUrl = "https://routed.example", apiKey = "k", tunnelId = tunnel.GetProperty("id").GetString() })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("tunnel", routed.GetProperty("route").GetProperty("kind").GetString());

        var provider = await (await client.PostAsJsonAsync("/api/v1/config/providers", new { name = "P", host = "news.example" })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("direct", provider.GetProperty("route").GetProperty("kind").GetString());
    }

    public sealed class ProxyFactory : WebApplicationFactory<Program>, IDisposable
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-tunnels-proxy-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
                ["Streamarr:PreDownload:CachePath"] = Path.Combine(_dir, "pre-download"),
                ["Streamarr:IndexerProxy"] = "http://gluetun:8888",
                ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            }));
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }
}
