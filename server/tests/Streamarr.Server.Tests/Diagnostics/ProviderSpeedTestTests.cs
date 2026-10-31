using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Config;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>The admin's speed test of one stored provider: live pool connections only, or a capped own pool when it has none.</summary>
public sealed class ProviderSpeedTestTests(ITestOutputHelper output) : IAsyncLifetime
{
    private readonly List<MockNntpServer> _servers = [];
    private readonly List<MultiProviderNntpClient> _pools = [];
    private int _streams;

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        foreach (var pool in _pools)
            pool.Dispose();
        foreach (var server in _servers)
            await server.DisposeAsync();
    }

    private MockNntpServer Server(int bytesPerSecond = 0)
    {
        var server = new MockNntpServer { RequireAuth = true, BodyBytesPerSecond = bytesPerSecond };
        server.Articles["speed@test"] = YencTestEncoder.Encode(YencTestEncoder.LcgBytes(93, 256 * 1024), "speed.bin");
        _servers.Add(server);
        return server;
    }

    private static UsenetProvider Provider(MockNntpServer server, string name, int max) => new()
    {
        Name = name,
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = max,
    };

    private MultiConnectionNntpClient Live(UsenetProvider provider)
    {
        var pool = UsenetStreamingClient.Create([provider]);
        _pools.Add(pool);
        return pool.Providers[0];
    }

    private UsenetSpeedTestService Service(int bytesPerSecond = 0) => new(
        new MultiProviderNntpClient([]), () => _streams, TimeProvider.System, NullLogger<UsenetSpeedTestService>.Instance)
    {
        ConnectTimeout = TimeSpan.FromSeconds(3),
        ProviderTestMaximumBytes = 32L * 1024 * 1024,
    };

    private static Task<ProviderSpeedTestResult> Test(
        UsenetSpeedTestService service, ProviderSpeedTarget target, string? messageId = null, int seconds = 1)
        => service.TestProviderAsync(target, messageId, seconds, CancellationToken.None);

    [Theory]
    [InlineData(20, 20, 0, 0, 20, 20)] // idle: the admin gets every configured connection
    [InlineData(20, 20, 0, 0, 8, 8)] // the viewer test stays at eight
    [InlineData(10, 10, 1, 0, 10, 2)] // a stream plays: two, whatever was requested
    [InlineData(10, 2, 1, 8, 10, 0)] // only the streams' reserve is free: none
    public void ConnectionTarget_HonoursTheRequestOnlyUpToWhatIsFree(int max, int available, int streams, int poolActive, int limit, int expected)
        => Assert.Equal(expected, UsenetSpeedTestService.ConnectionTarget(max, available, streams, poolActive, limit));

    [Fact]
    public async Task Idle_DiscoversAnArticle_AndUsesAllConfiguredConnections_FromTheLivePool()
    {
        var server = Server();
        var live = Live(Provider(server, "Main", max: 4));
        await live.WarmAsync(4);

        var result = await Test(Service(), new ProviderSpeedTarget(Provider(server, "Main", 4), live, 0, 0), seconds: 2);

        Assert.True(result.Success, result.Error);
        Assert.Equal("newsgroup", result.ArticleSource);
        Assert.Equal(4, result.RequestedConnections);
        Assert.Equal(4, result.ConnectionsGranted);
        Assert.Equal(4, result.ConnectionsUsed);
        Assert.Null(result.Notice);
        Assert.True(result.BytesDownloaded > 0 && result.MegabitsPerSecond > 0);
        Assert.InRange(Math.Abs(result.RecommendedVideoBitrateMbps - result.MegabitsPerSecond * 0.70), 0, 0.02);
        // the warm pool's idle connections were reused: never more open than the account allows
        Assert.True(server.MaxObservedConnections <= 4, $"observed {server.MaxObservedConnections}");
        Assert.Equal(0, live.ActiveConnections);
        output.WriteLine("Loopback NNTP: {0:F2} Mbps over {1} connections, tier {2}", result.MegabitsPerSecond, result.ConnectionsUsed, result.StreamingTier);
    }

    [Fact]
    public async Task NextToStreams_UsesTwoConnections_LeavesTheirsAlone_AndSaysSo()
    {
        var server = Server();
        var live = Live(Provider(server, "Main", max: 8));
        var (streamLocks, _) = await live.TryBorrowConnectionsAsync(3);
        _streams = 2;
        try
        {
            var result = await Test(Service(), new ProviderSpeedTarget(Provider(server, "Main", 8), live, 0, 0), messageId: "speed@test");

            Assert.True(result.Success, result.Error);
            Assert.Equal("manual", result.ArticleSource);
            Assert.Equal(8, result.RequestedConnections);
            Assert.Equal(2, result.ConnectionsGranted);
            Assert.InRange(result.ConnectionsUsed, 1, 2);
            Assert.Equal(3, result.ConnectionsInUse);
            Assert.Equal(2, result.ActiveStreams);
            Assert.Contains("Measured with 2 of 8 connections", result.Notice);
            Assert.Contains("2 active streams", result.Notice);
            Assert.True(server.MaxObservedConnections <= 8);
            Assert.Equal(3, live.ActiveConnections);
        }
        finally
        {
            foreach (var held in streamLocks)
                held.Dispose();
        }
    }

    [Fact]
    public async Task NoneFree_DoesNotTest_AndSaysWhy()
    {
        var server = Server();
        var live = Live(Provider(server, "Main", max: 2));
        var (held, _) = await live.TryBorrowConnectionsAsync(2);
        _streams = 1;
        try
        {
            var bodies = server.BodiesServed;
            var result = await Test(Service(), new ProviderSpeedTarget(Provider(server, "Main", 2), live, 0, 0));

            Assert.False(result.Success);
            Assert.Equal(0, result.ConnectionsGranted);
            Assert.Equal(2, result.ConnectionsInUse);
            Assert.StartsWith("No free connection of 2", result.Error);
            Assert.Equal(result.Error, result.Notice);
            Assert.Equal(bodies, server.BodiesServed);
            Assert.True(server.MaxObservedConnections <= 2);
        }
        finally
        {
            foreach (var l in held)
                l.Dispose();
        }
    }

    [Fact]
    public async Task WithoutALivePool_OpensItsOwn_CappedAtTheMaximum()
    {
        var server = Server();

        var result = await Test(Service(), new ProviderSpeedTarget(Provider(server, "Disabled", 3), null, 0, 0));

        Assert.True(result.Success, result.Error);
        Assert.Equal(3, result.ConnectionsGranted);
        Assert.Equal(3, result.ConnectionsUsed);
        Assert.True(server.MaxObservedConnections <= 3, $"observed {server.MaxObservedConnections}");
    }

    [Fact]
    public async Task WithoutALivePool_SubtractsWhatTheSameAccountHoldsOpen()
    {
        var server = Server();
        var other = Live(Provider(server, "Same account", max: 4));
        var (held, _) = await other.TryBorrowConnectionsAsync(2);
        held[1].Dispose(); // one busy, one idle: both are open sockets on the account
        try
        {
            var target = new ProviderSpeedTarget(Provider(server, "Disabled twin", 4), null, other.LiveConnections, other.ActiveConnections);
            var result = await Test(Service(), target);

            Assert.True(result.Success, result.Error);
            Assert.Equal(1, result.ConnectionsGranted); // 2 free, busy → a quarter stays free
            Assert.Equal(2, result.ConnectionsInUse);
            Assert.Equal(0, result.ActiveStreams);
            Assert.Contains("another provider entry on the same account", result.Notice);
            Assert.True(server.MaxObservedConnections <= 4, $"observed {server.MaxObservedConnections}");
        }
        finally
        {
            held[0].Dispose();
        }
    }

    [Fact]
    public async Task OnlyOneTestAtATime_TheViewerTestBlocksTheAdmin()
    {
        var server = Server(bytesPerSecond: 2 * 1024 * 1024);
        var provider = Provider(server, "Main", 4);
        var pool = UsenetStreamingClient.Create([provider]);
        _pools.Add(pool);
        var service = new UsenetSpeedTestService(pool, () => 0, TimeProvider.System, NullLogger<UsenetSpeedTestService>.Instance)
        {
            MeasureDuration = TimeSpan.FromSeconds(1.5),
        };

        var viewer = service.RunAsync("viewer:a", true, CancellationToken.None);
        while (server.BodiesServed == 0 && !viewer.IsCompleted)
            await Task.Delay(20);
        var admin = await Test(service, new ProviderSpeedTarget(provider, pool.Providers[0], 0, 0));

        Assert.False(admin.Success);
        Assert.Contains("already running", admin.Error);
        Assert.Equal("ok", (await viewer).Result!.Status);
        Assert.True((await Test(service, new ProviderSpeedTarget(provider, pool.Providers[0], 0, 0), "speed@test")).Success);
    }

    [Theory]
    [InlineData(8, 8, 0, 0, 0, null)]
    [InlineData(8, 2, 3, 2, 0, "Measured with 2 of 8 connections (3 in use, 2 active streams)")]
    [InlineData(8, 2, 0, 1, 0, "Measured with 2 of 8 connections (1 active stream)")]
    [InlineData(4, 0, 4, 0, 0, "No free connection of 4 (4 in use by playback or pre-downloads)")]
    public void Notice_ExplainsFewerConnections(int requested, int granted, int inUse, int streams, int elsewhere, string? expected)
    {
        var notice = UsenetSpeedTestService.ProviderNotice(requested, granted, inUse, streams, elsewhere);
        if (expected is null)
            Assert.Null(notice);
        else
            Assert.StartsWith(expected, notice);
    }
}
