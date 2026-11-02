using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Server.Contracts;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Tunnels;
using Streamarr.Tests.Shared;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>
/// The real thing without a VPN account: one streamarr-tunnel acts as the "VPN server" (listens on loopback UDP,
/// forwards 10.200.0.1:563 and :80 to a mock NNTP server and a mock Newznab indexer, answers DNS for *.test), the
/// server runs a second one as a normal tunnel. Provider test, indexer caps test and a search go through it; killing
/// the helper or disabling the tunnel makes them fail with vpn_down and nothing reaches the mocks.
/// </summary>
public sealed class TunnelRoutingE2ETests(ITestOutputHelper output)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task ProviderIndexerAndSearch_GoThroughTheTunnel_AndFailClosedWhenItDrops()
    {
        var helper = TunnelHelperBinary.Locate();
        if (helper is null)
        {
            output.WriteLine("streamarr-tunnel is not built; run server/scripts/build-tunnel-helper.sh to enable this test.");
            return;
        }

        var (serverPrivate, serverPublic) = KeyPair();
        var (clientPrivate, clientPublic) = KeyPair();
        await using var nntp = new MockNntpServer { RequireAuth = true, Username = "lab", Password = "secret" };
        await using var newznab = new MockNewznab();
        var udpPort = FreeUdpPort();
        await using var vpnServer = await LabVpnServer.StartAsync(helper, output, new
        {
            privateKey = serverPrivate,
            peerPublicKey = clientPublic,
            listenPort = udpPort,
            addresses = new[] { "10.200.0.1/24" },
            allowedIps = new[] { "10.200.0.2/32" },
            socksDisabled = true,
            statusPort = 0,
            forwards = new object[]
            {
                new { listen = "10.200.0.1:563", target = $"127.0.0.1:{nntp.Port}" },
                new { listen = "10.200.0.1:80", target = $"127.0.0.1:{newznab.Port}" },
            },
            dnsRecords = new Dictionary<string, string> { ["news.test"] = "10.200.0.1", ["indexer.test"] = "10.200.0.1", ["ip.test"] = "10.200.0.1" },
        });

        using var factory = new Factory(helper);
        using var client = factory.CreateClient();
        await client.AuthenticateAsAdminAsync();

        // 1. The tunnel comes up: handshake over loopback UDP, exit check through the tunnel to ip.test.
        var tunnelWrite = new
        {
            name = "Lab VPN",
            preset = "custom",
            enabled = true,
            privateKey = clientPrivate,
            peerPublicKey = serverPublic,
            endpoint = $"127.0.0.1:{udpPort}",
            addresses = new[] { "10.200.0.2/32" },
            dns = new[] { "10.200.0.1" },
            keepalive = 1,
            allowedIps = new[] { "10.200.0.0/24" },
        };
        var tunnel = await PostAsync<TunnelResponse>(client, "/api/v1/tunnels", tunnelWrite);
        var connected = await WaitForStateAsync(client, tunnel.Id, TunnelStates.Connected);
        Assert.Equal("10.200.0.2", connected.Status.ExitIp);
        Assert.NotNull(connected.Status.LastHandshakeUtc);
        Assert.True(connected.Status.LatencyMs > 0);
        Assert.Contains("ip.test", newznab.Hosts);

        // 2. Provider test: NNTP connect + AUTHINFO through SOCKS5 → WireGuard → forward → mock NNTP.
        var provider = await PostAsync<ProviderResponse>(client, "/api/v1/config/providers", new
        {
            name = "Lab provider", host = "news.test", port = 563, useSsl = false,
            username = "lab", password = "secret", maxConnections = 2, tunnelId = tunnel.Id,
        });
        Assert.Equal(RouteInfo.Tunnel, provider.Route.Kind);
        Assert.True(provider.Route.Usable);
        var providerTest = await PostAsync<JsonElement>(client, $"/api/v1/config/providers/{provider.Id}/test", null);
        Assert.True(providerTest.GetProperty("success").GetBoolean(), providerTest.ToString());
        Assert.Equal(2, providerTest.GetProperty("achievableConnections").GetInt32());
        Assert.True(nntp.MaxObservedConnections >= 1);

        // 3. Indexer caps test: HTTP with the hostname resolved inside the tunnel.
        var indexer = await PostAsync<IndexerResponse>(client, "/api/v1/config/indexers", new
        {
            name = "Lab indexer", baseUrl = "http://indexer.test/api", apiKey = "k", categories = new[] { 2000 }, tunnelId = tunnel.Id,
        });
        var indexerTest = await PostAsync<JsonElement>(client, $"/api/v1/config/indexers/{indexer.Id}/test", null);
        Assert.True(indexerTest.GetProperty("success").GetBoolean(), indexerTest.ToString());
        Assert.Equal("Lab Indexer", indexerTest.GetProperty("serverTitle").GetString());
        Assert.Contains("indexer.test", newznab.Hosts);

        // 4. A search fans out through the tunnel and gets releases back.
        var search = await PostAsync<DebugSearchResponse>(client, "/api/v1/debug/search", new { q = "Example Movie", type = "movie" });
        var outcome = Assert.Single(search.Indexers);
        Assert.Equal("succeeded", outcome.Status);
        Assert.True(outcome.ItemCount >= 3, $"items: {outcome.ItemCount}");
        Assert.True(newznab.SearchHits >= 1);

        // 5. The helper dies: down at once, then the supervisor restarts it and pooled callers reconnect.
        var supervisor = factory.Services.GetRequiredService<TunnelSupervisor>();
        var pid = supervisor.HelperProcessId(tunnel.Id);
        Assert.NotNull(pid);
        Process.GetProcessById(pid!.Value).Kill();
        var down = await WaitForStateAsync(client, tunnel.Id, TunnelStates.Down);
        Assert.StartsWith("helper exited with code", down.Status.LastError);
        var restarted = await WaitForStateAsync(client, tunnel.Id, TunnelStates.Connected);
        Assert.NotEqual(pid, supervisor.HelperProcessId(tunnel.Id));
        Assert.Equal("10.200.0.2", restarted.Status.ExitIp);
        var afterRestart = await PostAsync<JsonElement>(client, $"/api/v1/config/providers/{provider.Id}/test", null);
        Assert.True(afterRestart.GetProperty("success").GetBoolean(), afterRestart.ToString());

        // 6. Disabling the tunnel: every routed call fails closed with vpn_down and the mocks see nothing.
        var disabled = await PutAsync<TunnelResponse>(client, $"/api/v1/tunnels/{tunnel.Id}", new
        {
            tunnelWrite.name, tunnelWrite.preset, enabled = false, tunnelWrite.peerPublicKey, tunnelWrite.endpoint,
            tunnelWrite.addresses, tunnelWrite.dns, tunnelWrite.keepalive, tunnelWrite.allowedIps,
        });
        Assert.Equal(TunnelStates.Disabled, disabled.Status.State);
        var newznabHits = newznab.Hits;
        var nntpConnections = nntp.MaxObservedConnections;

        var providerDown = await PostAsync<JsonElement>(client, $"/api/v1/config/providers/{provider.Id}/test", null);
        Assert.False(providerDown.GetProperty("success").GetBoolean());
        Assert.Equal(TunnelUnavailableException.Code, providerDown.GetProperty("errorCode").GetString());
        Assert.Contains("VPN down: tunnel 'Lab VPN' is disabled", providerDown.GetProperty("error").GetString());

        var indexerDown = await PostAsync<JsonElement>(client, $"/api/v1/config/indexers/{indexer.Id}/test", null);
        Assert.False(indexerDown.GetProperty("success").GetBoolean());
        Assert.Equal(TunnelUnavailableException.Code, indexerDown.GetProperty("errorCode").GetString());

        // With its only indexer failing closed, search answers 503 search_temporarily_unavailable (existing contract).
        using (var searchDown = await client.PostAsJsonAsync("/api/v1/debug/search", new { q = "Example Movie again", type = "movie" }))
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, searchDown.StatusCode);
            var error = await searchDown.Content.ReadFromJsonAsync<ErrorResponse>(Json);
            Assert.Equal("search_temporarily_unavailable", error!.Error.Code);
        }

        var providerView = await client.GetFromJsonAsync<ProviderResponse>($"/api/v1/config/providers/{provider.Id}", Json);
        Assert.False(providerView!.Route.Usable);
        Assert.Equal(TunnelStates.Disabled, providerView.Route.State);
        var diagnostics = await client.GetFromJsonAsync<DiagnosticsResponse>("/api/v1/diagnostics?refresh=true", Json);
        Assert.Equal(TunnelUnavailableException.Code, Assert.Single(diagnostics!.Components, c => c.Kind == "provider").ErrorCode);
        Assert.Equal(TunnelUnavailableException.Code, Assert.Single(diagnostics.Components, c => c.Kind == "indexer").ErrorCode);
        Assert.Equal(newznabHits, newznab.Hits);
        Assert.Equal(nntpConnections, nntp.MaxObservedConnections);

        // 7. Re-enabling brings everything back.
        await PutAsync<TunnelResponse>(client, $"/api/v1/tunnels/{tunnel.Id}", new
        {
            tunnelWrite.name, tunnelWrite.preset, enabled = true, tunnelWrite.peerPublicKey, tunnelWrite.endpoint,
            tunnelWrite.addresses, tunnelWrite.dns, tunnelWrite.keepalive, tunnelWrite.allowedIps,
        });
        await WaitForStateAsync(client, tunnel.Id, TunnelStates.Connected);
        var providerUp = await PostAsync<JsonElement>(client, $"/api/v1/config/providers/{provider.Id}/test", null);
        Assert.True(providerUp.GetProperty("success").GetBoolean(), providerUp.ToString());
    }

    private async Task<TunnelResponse> WaitForStateAsync(HttpClient client, string id, string state)
    {
        var deadline = DateTime.UtcNow.AddSeconds(45);
        TunnelResponse? last = null;
        while (DateTime.UtcNow < deadline)
        {
            last = await client.GetFromJsonAsync<TunnelResponse>($"/api/v1/tunnels/{id}", Json);
            if (last!.Status.State == state)
            {
                output.WriteLine($"tunnel {state}: exitIp={last.Status.ExitIp} latencyMs={last.Status.LatencyMs} lastError={last.Status.LastError}");
                return last;
            }
            await Task.Delay(250);
        }
        Assert.Fail($"Tunnel did not become {state}; last state {last?.Status.State} ({last?.Status.LastError}).");
        return last!;
    }

    private static async Task<T> PostAsync<T>(HttpClient client, string path, object? body)
    {
        using var response = body is null ? await client.PostAsync(path, null) : await client.PostAsJsonAsync(path, body);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{path}: {(int)response.StatusCode} {text}");
        return JsonSerializer.Deserialize<T>(text, Json)!;
    }

    private static async Task<T> PutAsync<T>(HttpClient client, string path, object body)
    {
        using var response = await client.PutAsJsonAsync(path, body);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{path}: {(int)response.StatusCode} {text}");
        return JsonSerializer.Deserialize<T>(text, Json)!;
    }

    private static (string Private, string Public) KeyPair()
    {
        var secret = RandomNumberGenerator.GetBytes(32);
        secret[0] &= 248;
        secret[31] &= 127;
        secret[31] |= 64;
        return (Convert.ToBase64String(secret), Convert.ToBase64String(Curve25519.PublicKey(secret)));
    }

    private static int FreeUdpPort()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)socket.LocalEndPoint!).Port;
    }

    private sealed class Factory(string helper) : WebApplicationFactory<Program>
    {
        private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-tunnel-e2e-").FullName;

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
                ["Streamarr:PreDownload:CachePath"] = Path.Combine(_dir, "pre-download"),
                ["Streamarr:LoginAttemptsPerMinute"] = "1000",
                ["Streamarr:DeepHealthCacheSeconds"] = "1",
                ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
                ["Streamarr:Tunnels:HelperPath"] = helper,
                ["Streamarr:Tunnels:ExitCheckUrl"] = "http://ip.test/ip",
            }));
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<TunnelSupervisorTimings>();
                services.AddSingleton(new TunnelSupervisorTimings
                {
                    PollInterval = TimeSpan.FromMilliseconds(250),
                    FirstPollDelay = TimeSpan.FromMilliseconds(250),
                    ReadyTimeout = TimeSpan.FromSeconds(10),
                    HandshakeTimeout = TimeSpan.FromSeconds(20),
                    ExitCheckInterval = TimeSpan.FromHours(1),
                    RestartBackoffInitial = TimeSpan.FromMilliseconds(500),
                    RestartBackoffMax = TimeSpan.FromSeconds(2),
                });
            });
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing && Directory.Exists(_dir))
                Directory.Delete(_dir, recursive: true);
        }
    }

    /// <summary>The "VPN server" helper, driven directly by the test (server/test mode of streamarr-tunnel).</summary>
    private sealed class LabVpnServer : IAsyncDisposable
    {
        private readonly Process _process;

        private LabVpnServer(Process process) => _process = process;

        public static async Task<LabVpnServer> StartAsync(string helper, ITestOutputHelper output, object config)
        {
            var process = Process.Start(new ProcessStartInfo(helper)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            })!;
            _ = Task.Run(async () =>
            {
                while (await process.StandardError.ReadLineAsync() is { } line)
                    output.WriteLine("vpn-server: " + line);
            });
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(config));
            await process.StandardInput.FlushAsync();
            var ready = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Contains("\"ready\"", ready);
            return new LabVpnServer(process);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                _process.StandardInput.Close();
                if (!_process.WaitForExit(3000))
                    _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync();
            }
            finally
            {
                _process.Dispose();
            }
        }
    }

    /// <summary>Mock Newznab + exit-IP endpoint behind the lab VPN server (reached only via the tunnel).</summary>
    private sealed class MockNewznab : IAsyncDisposable
    {
        private const string CapsXml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <caps>
              <server version="1.1" title="Lab Indexer" />
              <limits max="100" default="100" />
              <searching>
                <search available="yes" supportedParams="q" />
                <tv-search available="yes" supportedParams="q,season,ep" />
                <movie-search available="yes" supportedParams="q,imdbid,tmdbid" />
              </searching>
              <categories><category id="2000" name="Movies"><subcat id="2040" name="HD" /></category></categories>
            </caps>
            """;

        private const string SearchXml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
              <channel>
                <title>Lab Indexer</title>
                <newznab:response offset="0" total="3" />
                <item>
                  <title>Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP</title>
                  <guid isPermaLink="true">http://indexer.test/details/a1</guid>
                  <pubDate>Wed, 30 Jun 2021 12:00:00 +0000</pubDate>
                  <enclosure url="http://indexer.test/getnzb/a1.nzb" length="5368709120" type="application/x-nzb" />
                  <newznab:attr name="category" value="2000" />
                  <newznab:attr name="category" value="2040" />
                  <newznab:attr name="size" value="5368709120" />
                  <newznab:attr name="guid" value="a1" />
                </item>
                <item>
                  <title>Example.Movie.2021.2160p.BluRay.x265.HDR10-GROUP</title>
                  <guid isPermaLink="true">http://indexer.test/details/a2</guid>
                  <pubDate>Thu, 01 Jul 2021 09:30:00 +0000</pubDate>
                  <enclosure url="http://indexer.test/getnzb/a2.nzb" length="27000000000" type="application/x-nzb" />
                  <newznab:attr name="category" value="2000" />
                  <newznab:attr name="size" value="27000000000" />
                  <newznab:attr name="guid" value="a2" />
                </item>
                <item>
                  <title>Example.Movie.2021.720p.WEB-DL.x264-OTHER</title>
                  <guid isPermaLink="true">http://indexer.test/details/a3</guid>
                  <pubDate>Fri, 02 Jul 2021 18:45:00 +0000</pubDate>
                  <enclosure url="http://indexer.test/getnzb/a3.nzb" length="3000000000" type="application/x-nzb" />
                  <newznab:attr name="category" value="2000" />
                  <newznab:attr name="guid" value="a3" />
                </item>
              </channel>
            </rss>
            """;

        private readonly HttpListener _listener = new();
        private readonly Task _serve;
        private int _hits;
        private int _searchHits;

        public MockNewznab()
        {
            Port = FreeTcpPort();
            _listener.Prefixes.Add($"http://*:{Port}/");
            _listener.Start();
            _serve = ServeAsync();
        }

        public int Port { get; }
        public int Hits => Volatile.Read(ref _hits);
        public int SearchHits => Volatile.Read(ref _searchHits);
        public System.Collections.Concurrent.ConcurrentBag<string> Hosts { get; } = [];

        private async Task ServeAsync()
        {
            try
            {
                while (_listener.IsListening)
                {
                    var context = await _listener.GetContextAsync();
                    Interlocked.Increment(ref _hits);
                    Hosts.Add(context.Request.UserHostName.Split(':')[0]);
                    var function = context.Request.QueryString["t"];
                    string body;
                    var type = "application/xml";
                    if (context.Request.Url?.AbsolutePath == "/ip")
                    {
                        body = """{"ip":"10.200.0.2"}""";
                        type = "application/json";
                    }
                    else if (function == "caps")
                    {
                        body = CapsXml;
                    }
                    else if (function is "movie" or "search" or "tvsearch")
                    {
                        Interlocked.Increment(ref _searchHits);
                        body = SearchXml;
                    }
                    else
                    {
                        context.Response.StatusCode = 404;
                        context.Response.Close();
                        continue;
                    }
                    var bytes = Encoding.UTF8.GetBytes(body);
                    context.Response.ContentType = type;
                    context.Response.ContentLength64 = bytes.Length;
                    await context.Response.OutputStream.WriteAsync(bytes);
                    context.Response.Close();
                }
            }
            catch (Exception e) when (e is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
            }
        }

        private static int FreeTcpPort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        public async ValueTask DisposeAsync()
        {
            _listener.Close();
            await _serve;
        }
    }
}
