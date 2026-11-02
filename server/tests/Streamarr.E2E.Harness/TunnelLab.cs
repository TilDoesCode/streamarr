using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Tunnels;
using Streamarr.Tests.Shared;

namespace Streamarr.E2E.Harness;

/// <summary>
/// Loopback WireGuard lab for the VPN UI E2E (docs/vpn.md): a second streamarr-tunnel in server mode plays the "VPN
/// server"; behind it, reachable only through the tunnel, sit news.test:563 (the mock NNTP server), indexer.test:80 (a
/// mock Newznab) and ip.test:80 (the exit-IP check). A loopback control API hands the Playwright spec the client .conf
/// and lets it kill the server's helper or stop/start the peer to show the fail-closed and auto-restart behaviour.
/// </summary>
internal sealed class TunnelLab : IAsyncDisposable
{
    public const string PeerAddress = "10.200.0.1";
    public const string ClientAddress = "10.200.0.2";
    public const string ExitCheckUrl = "http://ip.test/ip";
    public const string IndexerBaseUrl = "http://indexer.test/api";
    public const string NntpHost = "news.test";

    private readonly object _peerConfig;
    private readonly LabHttpServer _http;
    private readonly HttpListener _control = new();
    private readonly SemaphoreSlim _peerLock = new(1, 1);
    private readonly Task _serve;
    private LabVpnPeer? _peer;

    private TunnelLab(string helper, int udpPort, object peerConfig, LabHttpServer http, string clientConf, int controlPort)
    {
        HelperPath = helper;
        UdpPort = udpPort;
        _peerConfig = peerConfig;
        _http = http;
        ClientConf = clientConf;
        ControlPort = controlPort;
        _control.Prefixes.Add($"http://127.0.0.1:{controlPort}/");
        _control.Start();
        _serve = ServeAsync();
    }

    public string HelperPath { get; }
    public int UdpPort { get; }
    public int ControlPort { get; }

    /// <summary>The WireGuard .conf the operator imports through the UI.</summary>
    public string ClientConf { get; }

    /// <summary>Kills the server's own tunnel helpers (set by Program once the app runs); returns the pids.</summary>
    public Func<Task<IReadOnlyList<int>>>? KillHelpers { get; set; }

    /// <summary>Starts the lab, or returns null when the helper binary is not built.</summary>
    public static async Task<TunnelLab?> TryStartAsync(int controlPort, int nntpPort, string nzbXml)
    {
        var helper = TunnelHelperBinary.Locate();
        if (helper is null)
            return null;

        var (serverPrivate, serverPublic) = KeyPair();
        var (clientPrivate, clientPublic) = KeyPair();
        var udpPort = FreePorts.Udp();
        var http = new LabHttpServer(nzbXml);
        var peerConfig = new
        {
            privateKey = serverPrivate,
            peerPublicKey = clientPublic,
            listenPort = udpPort,
            addresses = new[] { PeerAddress + "/24" },
            allowedIps = new[] { ClientAddress + "/32" },
            socksDisabled = true,
            statusPort = 0,
            forwards = new object[]
            {
                new { listen = $"{PeerAddress}:563", target = $"127.0.0.1:{nntpPort}" },
                new { listen = $"{PeerAddress}:80", target = $"127.0.0.1:{http.Port}" },
            },
            dnsRecords = new Dictionary<string, string> { [NntpHost] = PeerAddress, ["indexer.test"] = PeerAddress, ["ip.test"] = PeerAddress },
        };
        var conf = $"""
            [Interface]
            PrivateKey = {clientPrivate}
            Address = {ClientAddress}/32
            DNS = {PeerAddress}

            [Peer]
            PublicKey = {serverPublic}
            AllowedIPs = 10.200.0.0/24
            Endpoint = 127.0.0.1:{udpPort}
            PersistentKeepalive = 1

            """;
        var lab = new TunnelLab(helper, udpPort, peerConfig, http, conf, controlPort);
        await lab.StartPeerAsync();
        return lab;
    }

    public bool PeerRunning => _peer is { HasExited: false };
    public int? PeerPid => _peer?.ProcessId;

    public async Task StartPeerAsync()
    {
        await _peerLock.WaitAsync();
        try
        {
            if (_peer is { HasExited: false })
                return;
            if (_peer is not null)
                await _peer.DisposeAsync();
            _peer = await LabVpnPeer.StartAsync(HelperPath, _peerConfig, line =>
            {
                if (line.Contains("\"level\":\"error\"", StringComparison.Ordinal) || line.Contains("\"level\":\"warn\"", StringComparison.Ordinal))
                    Console.Error.WriteLine("[e2e-harness] lab peer: " + line);
            });
        }
        finally
        {
            _peerLock.Release();
        }
    }

    public async Task StopPeerAsync()
    {
        await _peerLock.WaitAsync();
        try
        {
            if (_peer is null)
                return;
            _peer.Kill();
            await _peer.DisposeAsync();
            _peer = null;
        }
        finally
        {
            _peerLock.Release();
        }
    }

    private object Status() => new
    {
        enabled = true,
        peerRunning = PeerRunning,
        peerPid = PeerPid,
        udpPort = UdpPort,
        exitIp = ClientAddress,
        indexerBaseUrl = IndexerBaseUrl,
        nntpHost = NntpHost,
        nntpPort = 563,
        httpHits = _http.Hits,
        hosts = _http.Hosts.Distinct().OrderBy(h => h).ToArray(),
    };

    private async Task ServeAsync()
    {
        while (_control.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await _control.GetContextAsync();
            }
            catch (Exception e) when (e is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }
            _ = Task.Run(() => HandleAsync(context));
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var path = context.Request.Url?.AbsolutePath ?? "/";
        try
        {
            switch (context.Request.HttpMethod, path)
            {
                case ("GET", "/lab/status"):
                    await WriteAsync(context, 200, JsonSerializer.Serialize(Status()), "application/json");
                    break;
                case ("GET", "/lab/tunnel.conf"):
                    await WriteAsync(context, 200, ClientConf, "text/plain");
                    break;
                case ("POST", "/lab/peer/stop"):
                    await StopPeerAsync();
                    await WriteAsync(context, 200, JsonSerializer.Serialize(Status()), "application/json");
                    break;
                case ("POST", "/lab/peer/start"):
                    await StartPeerAsync();
                    await WriteAsync(context, 200, JsonSerializer.Serialize(Status()), "application/json");
                    break;
                case ("POST", "/lab/helper/kill"):
                    var killed = KillHelpers is null ? [] : await KillHelpers();
                    await WriteAsync(context, 200, JsonSerializer.Serialize(new { killed }), "application/json");
                    break;
                default:
                    await WriteAsync(context, 404, "not found", "text/plain");
                    break;
            }
        }
        catch (Exception e)
        {
            try
            {
                await WriteAsync(context, 500, e.Message, "text/plain");
            }
            catch (Exception inner) when (inner is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
            }
        }
    }

    private static async Task WriteAsync(HttpListenerContext context, int status, string body, string contentType)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        context.Response.StatusCode = status;
        context.Response.ContentType = contentType;
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes);
        context.Response.Close();
    }

    private static (string Private, string Public) KeyPair()
    {
        var secret = RandomNumberGenerator.GetBytes(32);
        secret[0] &= 248;
        secret[31] &= 127;
        secret[31] |= 64;
        return (Convert.ToBase64String(secret), Convert.ToBase64String(Curve25519.PublicKey(secret)));
    }

    public async ValueTask DisposeAsync()
    {
        _control.Close();
        await _serve;
        await StopPeerAsync();
        await _http.DisposeAsync();
    }
}

/// <summary>Mock Newznab (caps, search, NZB download) plus the exit-IP endpoint, reachable only through the lab tunnel.</summary>
internal sealed class LabHttpServer : IAsyncDisposable
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
            <newznab:response offset="0" total="1" />
            <item>
              <title>Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR</title>
              <guid isPermaLink="true">http://indexer.test/details/lab1</guid>
              <pubDate>Wed, 30 Jun 2021 12:00:00 +0000</pubDate>
              <enclosure url="http://indexer.test/getnzb/example.nzb" length="2400000000" type="application/x-nzb" />
              <newznab:attr name="category" value="2000" />
              <newznab:attr name="category" value="2040" />
              <newznab:attr name="size" value="2400000000" />
              <newznab:attr name="guid" value="lab1" />
            </item>
          </channel>
        </rss>
        """;

    private readonly HttpListener _listener = new();
    private readonly byte[] _nzb;
    private readonly Task _serve;
    private int _hits;

    public LabHttpServer(string nzbXml)
    {
        _nzb = Encoding.UTF8.GetBytes(nzbXml);
        Port = FreePorts.Tcp();
        // Requests arrive with Host: indexer.test / ip.test, so the prefix must not pin a host name.
        _listener.Prefixes.Add($"http://*:{Port}/");
        _listener.Start();
        _serve = ServeAsync();
    }

    public int Port { get; }
    public int Hits => Volatile.Read(ref _hits);
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
                var path = context.Request.Url?.AbsolutePath ?? "/";
                var function = context.Request.QueryString["t"];
                byte[] body;
                string type;
                if (path == "/ip")
                {
                    body = Encoding.UTF8.GetBytes($$"""{"ip":"{{TunnelLab.ClientAddress}}"}""");
                    type = "application/json";
                }
                else if (path == "/getnzb/example.nzb")
                {
                    body = _nzb;
                    type = "application/x-nzb";
                }
                else if (function == "caps")
                {
                    body = Encoding.UTF8.GetBytes(CapsXml);
                    type = "application/xml";
                }
                else if (function is "movie" or "search" or "tvsearch")
                {
                    body = Encoding.UTF8.GetBytes(SearchXml);
                    type = "application/xml";
                }
                else
                {
                    context.Response.StatusCode = 404;
                    context.Response.Close();
                    continue;
                }
                context.Response.ContentType = type;
                context.Response.ContentLength64 = body.Length;
                await context.Response.OutputStream.WriteAsync(body);
                context.Response.Close();
            }
        }
        catch (Exception e) when (e is HttpListenerException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    public async ValueTask DisposeAsync()
    {
        _listener.Close();
        await _serve;
    }
}

/// <summary>Indexers on a <c>.test</c> host use the real Newznab HTTP client (through their route); everything else stays canned.</summary>
internal sealed class LabNewznabClient(INewznabClient real, INewznabClient canned) : INewznabClient
{
    private static bool IsLab(IndexerConfig indexer)
        => Uri.TryCreate(indexer.BaseUrl, UriKind.Absolute, out var uri) && uri.Host.EndsWith(".test", StringComparison.OrdinalIgnoreCase);

    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => (IsLab(indexer) ? real : canned).GetCapabilitiesAsync(indexer, cancellationToken);

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
        => (IsLab(indexer) ? real : canned).SearchAsync(indexer, query, cancellationToken);
}
