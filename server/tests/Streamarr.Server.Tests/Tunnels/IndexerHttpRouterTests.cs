using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Tunnels;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>Indexer HTTP through the router: SOCKS5 with the hostname sent to the proxy, fail closed, direct for untunneled indexers.</summary>
public sealed class IndexerHttpRouterTests : IAsyncLifetime
{
    private const string CapsXml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <caps>
          <server version="1.1" title="Routed Indexer" />
          <limits max="100" default="100" />
          <searching>
            <search available="yes" supportedParams="q" />
            <tv-search available="yes" supportedParams="q,season,ep" />
            <movie-search available="yes" supportedParams="q,imdbid" />
          </searching>
          <categories><category id="2000" name="Movies" /></categories>
        </caps>
        """;

    private readonly HttpListener _indexer = new();
    private readonly FakeSocks5Server _socks = new();
    private readonly FakeSupervisor _supervisor = new();
    private int _indexerPort;
    private int _hits;

    public Task InitializeAsync()
    {
        _indexerPort = FreePort();
        _indexer.Prefixes.Add($"http://*:{_indexerPort}/");
        _indexer.Start();
        _ = ServeAsync();
        _socks.Resolve = (host, port) => host == "indexer.test" && port == 80 ? new IPEndPoint(IPAddress.Loopback, _indexerPort) : null;
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        _indexer.Close();
        await _socks.DisposeAsync();
    }

    private IndexerHttpRouter Router(string? legacyProxy = null) => new(
        _supervisor,
        Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { IndexerProxy = legacyProxy ?? string.Empty }),
        NullLogger<IndexerHttpRouter>.Instance);

    private static IndexerConfig Indexer(string? tunnelId, string baseUrl = "http://indexer.test") => new()
    {
        Id = "idx",
        Name = "Routed",
        BaseUrl = baseUrl,
        ApiKey = "k",
        TunnelId = tunnelId,
    };

    [Fact]
    public async Task TunnelRoute_NeverBypassesTheProxy_EvenForLoopbackDestinations()
    {
        // .NET's WebProxy skips the proxy for loopback hosts by default; a routed indexer must still go through the tunnel.
        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint);
        _socks.Resolve = (_, _) => new IPEndPoint(IPAddress.Loopback, _indexerPort);
        using var router = Router();
        using var http = new HttpClient(router.CreateHandler(), disposeHandler: true);

        foreach (var host in new[] { "127.0.0.1", "localhost" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://{host}:{_indexerPort}/api?t=caps").ForIndexer(Indexer("t1", $"http://{host}:{_indexerPort}"));
            using var response = await http.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(_socks.Requests.TryDequeue(out var connect), $"{host}: the request bypassed the SOCKS5 proxy");
            Assert.Equal(host, connect.Host);
            Assert.Equal(_indexerPort, connect.Port);
        }
    }

    [Fact]
    public async Task TunnelRoute_SendsTheHostnameToTheSocksProxy()
    {
        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint);
        using var router = Router();
        using var http = new HttpClient(router.CreateHandler(), disposeHandler: true);

        using var request = new HttpRequestMessage(HttpMethod.Get, "http://indexer.test/api?t=caps").ForIndexer(Indexer("t1"));
        using var response = await http.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("Routed Indexer", await response.Content.ReadAsStringAsync());
        var connect = Assert.Single(_socks.Requests);
        Assert.Equal(3, connect.AddressType);
        Assert.Equal("indexer.test", connect.Host);
        Assert.Equal(80, connect.Port);
    }

    [Fact]
    public async Task TunnelDown_FailsClosedWithoutContactingAnything()
    {
        _supervisor.Set("t1", "Mullvad", TunnelStates.Down, null, "handshake timeout: no handshake with 203.0.113.5:51820 after 31s");
        using var router = Router();
        using var http = new HttpClient(router.CreateHandler(), disposeHandler: true);

        using var request = new HttpRequestMessage(HttpMethod.Get, "http://indexer.test/api?t=caps").ForIndexer(Indexer("t1"));
        var error = await Assert.ThrowsAsync<HttpRequestException>(() => http.SendAsync(request));

        var tunnel = Assert.IsType<TunnelUnavailableException>(error.InnerException);
        Assert.Equal("t1", tunnel.TunnelId);
        Assert.Equal("Mullvad", tunnel.TunnelName);
        Assert.Contains("VPN down: tunnel 'Mullvad' is down (handshake timeout", error.Message);
        Assert.Empty(_socks.Requests);
        Assert.Equal(0, Volatile.Read(ref _hits));
    }

    [Fact]
    public async Task DirectIndexer_NeverTouchesTheProxy()
    {
        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint);
        using var router = Router();
        using var http = new HttpClient(router.CreateHandler(), disposeHandler: true);

        using var tagged = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{_indexerPort}/api?t=caps").ForIndexer(Indexer(null));
        using var untagged = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{_indexerPort}/api?t=caps");
        Assert.Equal(HttpStatusCode.OK, (await http.SendAsync(tagged)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.SendAsync(untagged)).StatusCode);

        Assert.Empty(_socks.Requests);
        Assert.Equal(2, Volatile.Read(ref _hits));
    }

    [Fact]
    public async Task TunnelRestart_OpensFreshProxyConnections()
    {
        var since = new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);
        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint, since: since);
        using var router = Router();
        using var http = new HttpClient(router.CreateHandler(), disposeHandler: true);

        using (var first = new HttpRequestMessage(HttpMethod.Get, "http://indexer.test/api?t=caps").ForIndexer(Indexer("t1")))
            (await http.SendAsync(first)).EnsureSuccessStatusCode();
        using (var again = new HttpRequestMessage(HttpMethod.Get, "http://indexer.test/api?t=caps").ForIndexer(Indexer("t1")))
            (await http.SendAsync(again)).EnsureSuccessStatusCode();
        Assert.Single(_socks.Requests);

        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint, since: since.AddMinutes(1));
        using (var afterRestart = new HttpRequestMessage(HttpMethod.Get, "http://indexer.test/api?t=caps").ForIndexer(Indexer("t1")))
            (await http.SendAsync(afterRestart)).EnsureSuccessStatusCode();

        Assert.Equal(2, _socks.Requests.Count);
    }

    [Fact]
    public async Task CapsTester_ThroughTheRouter_ReportsVpnDownAndSucceedsWhenConnected()
    {
        _supervisor.Set("t1", "Mullvad", TunnelStates.Degraded, null, "handshake stale: last handshake with 203.0.113.5:51820 200s ago");
        using var router = Router();
        var tester = new IndexerCapsTester(new NewznabClient(new HttpClient(router.CreateHandler(), disposeHandler: true)));

        var down = await tester.TestAsync(Indexer("t1"), CancellationToken.None);
        Assert.False(down.Success);
        Assert.Equal(TunnelUnavailableException.Code, down.ErrorCode);
        Assert.Contains("VPN down: tunnel 'Mullvad' is degraded", down.Error);
        Assert.Empty(_socks.Requests);

        _supervisor.Set("t1", "Mullvad", TunnelStates.Connected, _socks.EndPoint);
        var up = await tester.TestAsync(Indexer("t1"), CancellationToken.None);
        Assert.True(up.Success, up.ErrorDetail);
        Assert.Equal("Routed Indexer", up.ServerTitle);
        Assert.Equal("indexer.test", Assert.Single(_socks.Requests).Host);
    }

    private async Task ServeAsync()
    {
        try
        {
            while (_indexer.IsListening)
            {
                var context = await _indexer.GetContextAsync();
                Interlocked.Increment(ref _hits);
                var body = Encoding.UTF8.GetBytes(CapsXml);
                context.Response.ContentType = "application/xml";
                context.Response.ContentLength64 = body.Length;
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }
        }
        catch (Exception e) when (e is HttpListenerException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    internal sealed class FakeSupervisor : ITunnelSupervisor
    {
        private readonly Dictionary<string, (string Name, TunnelStatus Status, IPEndPoint? Proxy)> _tunnels = new(StringComparer.Ordinal);

        public void Set(string id, string name, string state, IPEndPoint? proxy, string? lastError = null, DateTimeOffset? since = null)
        {
            lock (_tunnels)
                _tunnels[id] = (name, new TunnelStatus { State = state, Since = since ?? DateTimeOffset.UnixEpoch, LastError = lastError }, proxy);
        }

        public TunnelStatus? GetStatus(string tunnelId)
        {
            lock (_tunnels)
                return _tunnels.TryGetValue(tunnelId, out var t) ? t.Status : null;
        }

        public string? GetName(string tunnelId)
        {
            lock (_tunnels)
                return _tunnels.TryGetValue(tunnelId, out var t) ? t.Name : null;
        }

        public IReadOnlyDictionary<string, TunnelStatus> Snapshot()
        {
            lock (_tunnels)
                return _tunnels.ToDictionary(kv => kv.Key, kv => kv.Value.Status, StringComparer.Ordinal);
        }

        public IPEndPoint? ProxyEndpoint(string tunnelId)
        {
            lock (_tunnels)
                return _tunnels.TryGetValue(tunnelId, out var t) && TunnelStates.IsUsable(t.Status.State) ? t.Proxy : null;
        }

        public Task ReloadAsync(CancellationToken ct) => Task.CompletedTask;

        public Task<TunnelTestResult> TestAsync(string tunnelId, CancellationToken ct)
            => Task.FromResult(new TunnelTestResult { Success = false, HandshakeOk = false, State = TunnelStates.Down });
    }
}
