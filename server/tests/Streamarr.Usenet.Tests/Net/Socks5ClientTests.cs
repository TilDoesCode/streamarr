using System.Net;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Net;
using Streamarr.Usenet.Nntp;
using Xunit;

namespace Streamarr.Usenet.Tests.Net;

public sealed class Socks5ClientTests
{
    [Fact]
    public void ConnectRequest_SendsHostnamesAsDomainNames()
    {
        var request = Socks5Client.BuildConnectRequest("news.example.test", 563);
        Assert.Equal(new byte[] { 5, 1, 0, 3, 17 }, request[..5]);
        Assert.Equal("news.example.test", System.Text.Encoding.ASCII.GetString(request[5..22]));
        Assert.Equal(new byte[] { 0x02, 0x33 }, request[22..]);
    }

    [Fact]
    public void ConnectRequest_SendsLiteralAddressesAsIPv4OrIPv6()
    {
        Assert.Equal(new byte[] { 5, 1, 0, 1, 203, 0, 113, 7, 0, 80 }, Socks5Client.BuildConnectRequest("203.0.113.7", 80));
        var v6 = Socks5Client.BuildConnectRequest("[2001:db8::1]", 8080);
        Assert.Equal(4, v6[3]);
        Assert.Equal(IPAddress.Parse("2001:db8::1"), new IPAddress(v6[4..20]));
        Assert.Equal(new byte[] { 0x1F, 0x90 }, v6[20..]);
    }

    [Fact]
    public void ConnectRequest_RejectsUnusableHostsAndPorts()
    {
        Assert.Throws<ArgumentException>(() => Socks5Client.BuildConnectRequest(new string('a', 256), 1));
        Assert.Throws<ArgumentException>(() => Socks5Client.BuildConnectRequest("nëws.test", 1));
        Assert.Throws<ArgumentException>(() => Socks5Client.BuildConnectRequest(" ", 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => Socks5Client.BuildConnectRequest("news.test", 0));
    }

    [Fact]
    public async Task NntpConnection_ThroughSocks5_SendsTheProviderHostnameToTheProxy()
    {
        await using var nntp = new MockNntpServer { RequireAuth = true, Username = "user", Password = "pass" };
        await using var socks = new FakeSocks5Server
        {
            Resolve = (host, port) => host == "news.test" && port == 563 ? new IPEndPoint(IPAddress.Loopback, nntp.Port) : null,
        };

        using var connection = new NntpConnection();
        await connection.ConnectAsync("news.test", 563, useSsl: false, socks.EndPoint, CancellationToken.None);
        var auth = await connection.AuthenticateAsync("user", "pass", CancellationToken.None);

        Assert.True(auth.Success);
        var request = Assert.Single(socks.Requests);
        Assert.Equal(3, request.AddressType);
        Assert.Equal("news.test", request.Host);
        Assert.Equal(563, request.Port);
    }

    [Fact]
    public async Task ProxyRefusal_SurfacesAsATunnelConnectError()
    {
        await using var socks = new FakeSocks5Server { ForcedReply = 0x05 };

        var client = new SingleConnectionNntpClient();
        var error = await Assert.ThrowsAsync<CouldNotConnectToUsenetException>(() =>
            client.ConnectAsync("news.test", 563, false, socks.EndPoint, CancellationToken.None));

        Assert.Contains("VPN tunnel", error.Message);
        Assert.Contains("refused", error.Message);
        var inner = Assert.IsType<Socks5Exception>(error.InnerException);
        Assert.Equal((byte)0x05, inner.ReplyCode);
    }

    [Fact]
    public async Task ProxyDemandingAuthentication_IsRejected()
    {
        await using var socks = new FakeSocks5Server { RequireAuth = true };
        using var connection = new NntpConnection();

        var error = await Assert.ThrowsAsync<Socks5Exception>(() =>
            connection.ConnectAsync("news.test", 563, false, socks.EndPoint, CancellationToken.None));

        Assert.Contains("authentication", error.Message);
    }

    [Fact]
    public async Task PoolConnectionFactory_UsesTheProviderRoute()
    {
        await using var nntp = new MockNntpServer { RequireAuth = true, Username = "user", Password = "pass" };
        await using var socks = new FakeSocks5Server
        {
            Resolve = (_, _) => new IPEndPoint(IPAddress.Loopback, nntp.Port),
        };
        var provider = new UsenetProvider
        {
            Name = "routed",
            Host = "news.test",
            Port = 563,
            UseSsl = false,
            Username = "user",
            Password = "pass",
            Route = NntpConnectionRoute.Socks5(socks.EndPoint),
        };

        using var connection = await UsenetStreamingClient.CreateNewConnection(provider, CancellationToken.None);

        Assert.Equal("news.test", Assert.Single(socks.Requests).Host);
    }

    [Fact]
    public async Task PoolConnectionFactory_FailsClosedWhenTheRouteThrows()
    {
        await using var socks = new FakeSocks5Server();
        var provider = new UsenetProvider
        {
            Name = "routed",
            Host = "news.test",
            Port = 563,
            UseSsl = false,
            Route = new ThrowingRoute(),
        };

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UsenetStreamingClient.CreateNewConnection(provider, CancellationToken.None).AsTask());

        Assert.Equal("VPN down: test", error.Message);
        Assert.Empty(socks.Requests);
    }

    [Fact]
    public async Task DefaultInterfaceConnect_RejectsProxiesForDirectOnlyClients()
    {
        INntpClient client = new DirectOnlyClient();
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            client.ConnectAsync("news.test", 563, false, new IPEndPoint(IPAddress.Loopback, 1), CancellationToken.None));
        await client.ConnectAsync("news.test", 563, false, null, CancellationToken.None);
    }

    private sealed class ThrowingRoute : NntpConnectionRoute
    {
        public override IPEndPoint? ResolveProxy() => throw new InvalidOperationException("VPN down: test");
    }

    private sealed class DirectOnlyClient : NntpClientBase
    {
        public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken) => throw new NotImplementedException();
        public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken) => throw new NotImplementedException();
        public override void Dispose() { }
    }
}
