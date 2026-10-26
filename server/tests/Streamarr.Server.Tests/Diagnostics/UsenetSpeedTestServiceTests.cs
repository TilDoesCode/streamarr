using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Server ↔ Usenet speed test against real mock NNTP servers through the real provider pools.</summary>
public sealed class UsenetSpeedTestServiceTests : IAsyncLifetime
{
    private readonly List<MockNntpServer> _servers = [];
    private readonly List<MultiProviderNntpClient> _pools = [];
    private readonly ManualClock _clock = new(DateTimeOffset.UtcNow);
    private int _streams;

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        foreach (var pool in _pools)
            pool.Dispose();
        foreach (var server in _servers)
            await server.DisposeAsync();
    }

    private MockNntpServer Server(bool withArticle = true, int bytesPerSecond = 0)
    {
        var server = new MockNntpServer { RequireAuth = true, BodyBytesPerSecond = bytesPerSecond };
        if (withArticle)
            server.Articles["speed@test"] = YencTestEncoder.Encode(YencTestEncoder.LcgBytes(7, 256 * 1024), "speed.bin");
        _servers.Add(server);
        return server;
    }

    private static UsenetProvider Provider(MockNntpServer server, string name, int priority, int max = 4, string? password = null) => new()
    {
        Name = name,
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = password ?? server.Password,
        MaxConnections = max,
        Priority = priority,
    };

    private MultiProviderNntpClient Pool(params UsenetProvider[] providers)
    {
        var pool = UsenetStreamingClient.Create(providers);
        _pools.Add(pool);
        return pool;
    }

    private UsenetSpeedTestService Service(MultiProviderNntpClient pool, double seconds = 0.6) => new(pool, () => _streams, _clock, NullLogger<UsenetSpeedTestService>.Instance)
    {
        MeasureDuration = TimeSpan.FromSeconds(seconds),
        ConnectTimeout = TimeSpan.FromSeconds(3),
    };

    [Theory]
    [InlineData(20, 20, 0, 0, 8)] // idle: up to eight
    [InlineData(4, 4, 0, 0, 4)] // never above the provider's maximum
    [InlineData(10, 3, 0, 7, 1)] // pool busy (pre-download): a quarter of the maximum stays free
    [InlineData(10, 10, 1, 0, 2)] // a stream plays: two
    [InlineData(10, 2, 1, 8, 0)] // a stream plays and only its reserve is free: none
    [InlineData(4, 0, 0, 4, 0)] // nothing free
    public void ConnectionTarget_NeverExceedsWhatIsFree(int max, int available, int streams, int poolActive, int expected)
    {
        var target = UsenetSpeedTestService.ConnectionTarget(max, available, streams, poolActive);
        Assert.Equal(expected, target);
        Assert.True(target <= available);
    }

    [Fact]
    public async Task Measures_ThePrimary_WithinTheProvidersConnectionLimit_EvenWithAWarmPool()
    {
        var primary = Server();
        var pool = Pool(Provider(primary, "Primary", 0, max: 4), Provider(Server(), "Backup", 1, max: 4));
        await pool.Providers[0].WarmAsync(4);
        Assert.Equal(4, pool.Providers[0].IdleConnections);

        var run = await Service(pool).RunAsync("viewer:a", limitCaller: true, CancellationToken.None);

        var result = run.Result!;
        Assert.Equal("ok", result.Status);
        Assert.True(result.MegabitsPerSecond > 0);
        Assert.Equal(1, result.Provider!.Index);
        Assert.Equal("primary", result.Provider.Role);
        Assert.False(result.FallbackUsed);
        Assert.Equal(4, result.ConnectionsUsed);
        Assert.Equal(4, result.ConnectionsMax);
        Assert.Equal(0, result.ActiveStreams);
        // the test borrowed the pool's own connections: never more open than the account allows
        Assert.True(primary.MaxObservedConnections <= 4, $"observed {primary.MaxObservedConnections}");
        Assert.Equal(0, pool.Providers[0].ActiveConnections);
    }

    [Fact]
    public async Task NextToActiveStreams_UsesFewConnections_LeavesTheirsAlone_AndSaysSo()
    {
        var primary = Server();
        var pool = Pool(Provider(primary, "Primary", 0, max: 8));
        var (streamLocks, _) = await pool.Providers[0].TryBorrowConnectionsAsync(3);
        _streams = 2;
        try
        {
            var result = (await Service(pool).RunAsync("viewer:a", true, CancellationToken.None)).Result!;

            Assert.Equal("ok", result.Status);
            Assert.Equal(2, result.ActiveStreams);
            Assert.InRange(result.ConnectionsUsed, 1, UsenetSpeedTestService.BusyTestConnections);
            Assert.True(primary.MaxObservedConnections <= 8);
            Assert.Equal(3, pool.Providers[0].ActiveConnections);
        }
        finally
        {
            foreach (var held in streamLocks)
                held.Dispose();
        }
    }

    [Fact]
    public async Task NoFreeConnection_IsBusy_WithoutTesting_AndNotStored()
    {
        var primary = Server();
        var pool = Pool(Provider(primary, "Primary", 0, max: 2), Provider(Server(), "Backup", 1));
        var (held, _) = await pool.Providers[0].TryBorrowConnectionsAsync(2);
        _streams = 1;
        var service = Service(pool);
        try
        {
            var bodies = primary.BodiesServed;
            var run = await service.RunAsync("viewer:a", true, CancellationToken.None);

            Assert.Equal("busy", run.Result!.Status);
            Assert.Equal("no_free_connections", run.Result.Code);
            Assert.Equal(bodies, primary.BodiesServed);
            Assert.Null(service.Latest);
            Assert.True(primary.MaxObservedConnections <= 2);
        }
        finally
        {
            foreach (var l in held)
                l.Dispose();
        }
    }

    [Fact]
    public async Task FailingPrimary_FallsBackToTheNextProvider_AndSaysSo()
    {
        var pool = Pool(Provider(Server(), "Primary", 0, password: "wrong"), Provider(Server(), "Backup", 1));

        var result = (await Service(pool).RunAsync("viewer:a", true, CancellationToken.None)).Result!;

        Assert.Equal("ok", result.Status);
        Assert.True(result.FallbackUsed);
        Assert.Equal(2, result.Provider!.Index);
        Assert.Equal("backup", result.Provider.Role);
        Assert.Equal(["auth_failed", "ok"], result.Attempts.Select(a => a.Code));
        Assert.Equal(["primary", "backup"], result.Attempts.Select(a => a.Role));
    }

    [Fact]
    public async Task PrimaryWithoutATestArticle_FallsBack()
    {
        var pool = Pool(Provider(Server(withArticle: false), "Primary", 0), Provider(Server(), "Backup", 1));

        var result = (await Service(pool).RunAsync("viewer:a", true, CancellationToken.None)).Result!;

        Assert.Equal("ok", result.Status);
        Assert.Equal(["no_article", "ok"], result.Attempts.Select(a => a.Code));
    }

    [Fact]
    public async Task EveryProviderFailing_IsAFailedResult_WithTheLastCode()
    {
        var pool = Pool(Provider(Server(), "Primary", 0, password: "wrong"), Provider(Server(withArticle: false), "Backup", 1));

        var result = (await Service(pool).RunAsync("viewer:a", true, CancellationToken.None)).Result!;

        Assert.Equal("failed", result.Status);
        Assert.Equal("no_article", result.Code);
        Assert.Equal(["auth_failed", "no_article"], result.Attempts.Select(a => a.Code));
    }

    [Fact]
    public async Task ConcurrentCallers_JoinOneTest()
    {
        var primary = Server(bytesPerSecond: 2 * 1024 * 1024);
        var pool = Pool(Provider(primary, "Primary", 0));
        var service = Service(pool, seconds: 1.0);

        var runs = await Task.WhenAll(Enumerable.Range(0, 4).Select(i => service.RunAsync($"viewer:{i}", true, CancellationToken.None)));

        Assert.Single(runs.Select(r => r.Result).Distinct());
        Assert.Equal(1, runs.Count(r => !r.Joined && !r.Reused));
        Assert.Equal(3, runs.Count(r => r.Joined));
    }

    [Fact]
    public async Task ARecentResult_IsShared_ThenATestRunsAgain()
    {
        var primary = Server();
        var pool = Pool(Provider(primary, "Primary", 0));
        var service = Service(pool);
        var first = await service.RunAsync("viewer:a", true, CancellationToken.None);
        var bodies = primary.BodiesServed;

        _clock.Advance(TimeSpan.FromSeconds(90));
        var shared = await service.RunAsync("viewer:b", true, CancellationToken.None);
        Assert.True(shared.Reused);
        Assert.Same(first.Result, shared.Result);
        Assert.Equal(bodies, primary.BodiesServed);

        _clock.Advance(TimeSpan.FromSeconds(31));
        var again = await service.RunAsync("viewer:b", true, CancellationToken.None);
        Assert.False(again.Reused);
        Assert.NotSame(first.Result, again.Result);
        Assert.True(primary.BodiesServed > bodies);
    }

    [Fact]
    public async Task EachCaller_MayStartOnlyAFewTests()
    {
        var pool = Pool(Provider(Server(), "Primary", 0));
        var service = Service(pool, seconds: 0.2);
        for (var i = 0; i < UsenetSpeedTestService.CallerStartsPerWindow; i++)
        {
            Assert.False((await service.RunAsync("viewer:a", true, CancellationToken.None)).RateLimited);
            _clock.Advance(UsenetSpeedTestService.ReuseOk);
        }

        var limited = await service.RunAsync("viewer:a", true, CancellationToken.None);
        Assert.True(limited.RateLimited);
        Assert.True(limited.RetryAfter > TimeSpan.Zero);
        Assert.False((await service.RunAsync("viewer:other", true, CancellationToken.None)).RateLimited);
        _clock.Advance(UsenetSpeedTestService.ReuseOk);
        Assert.False((await service.RunAsync("admin:x", limitCaller: false, CancellationToken.None)).RateLimited);
    }

    [Fact]
    public async Task Bandwidth_ForBitrateChecks_IsTheLastOkResult_UpToItsMaxAge()
    {
        var pool = Pool(Provider(Server(), "Primary", 0));
        var service = Service(pool);
        Assert.Null(service.BandwidthKbps(TimeSpan.FromDays(7)));

        var result = (await service.RunAsync("viewer:a", true, CancellationToken.None)).Result!;
        Assert.Equal((int)Math.Round(result.MegabitsPerSecond * 1000), service.BandwidthKbps(TimeSpan.FromDays(7)));

        _clock.Advance(TimeSpan.FromDays(8));
        Assert.Null(service.BandwidthKbps(TimeSpan.FromDays(7)));
    }

    [Fact]
    public void Mapping_Redacts_NamesAndErrors_ForViewers()
    {
        var result = new UsenetSpeedResult
        {
            Status = "ok",
            MeasuredAt = DateTimeOffset.UnixEpoch,
            MegabitsPerSecond = 120,
            Provider = new UsenetSpeedAttempt(2, "backup", "Secret Backup", "ok", null),
            FallbackUsed = true,
            Attempts = [new UsenetSpeedAttempt(1, "primary", "Secret Primary", "auth_failed", "481 nope at news.secret.example"), new UsenetSpeedAttempt(2, "backup", "Secret Backup", "ok", null)],
        };

        var viewer = UsenetSpeedMapping.Response(result, redact: true);
        var json = System.Text.Json.JsonSerializer.Serialize(viewer);
        Assert.DoesNotContain("Secret", json);
        Assert.DoesNotContain("481", json);
        Assert.Equal("auth_failed", viewer.Attempts[0].Code);
        Assert.Equal(2, viewer.Provider!.Index);

        var admin = UsenetSpeedMapping.Response(result, redact: false);
        Assert.Equal("Secret Backup", admin.Provider!.Name);
        Assert.Contains("481", admin.Attempts[0].Error);
    }
}
