using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Tests.Shared;

namespace Streamarr.Usenet.Tests.Nntp;

public class PoolingTests
{
    private static UsenetProvider ProviderFor(MockNntpServer server, int maxConnections, int priority = 0,
        string? name = null) => new()
    {
        Name = name ?? $"mock:{server.Port}",
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = maxConnections,
        Priority = priority,
    };

    [Fact]
    public async Task PooledClient_RespectsMaxConnections_UnderConcurrency()
    {
        var data = YencTestEncoder.LcgBytes(1, 20_000);
        await using var server = new MockNntpServer();
        for (var i = 0; i < 12; i++)
            server.Articles[$"seg{i}@test"] = YencTestEncoder.Encode(data, $"f{i}.bin");

        using var client = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 3));

        var tasks = Enumerable.Range(0, 12).Select(async i =>
        {
            var response = await client.DecodedBodyAsync($"seg{i}@test", CancellationToken.None);
            await using var stream = response.Stream;
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
            return ms.ToArray();
        });

        var results = await Task.WhenAll(tasks);

        Assert.All(results, r => Assert.Equal(data, r));
        Assert.InRange(server.MaxObservedConnections, 1, 3);
    }

    [Fact]
    public async Task PooledClient_ReusesIdleConnections()
    {
        await using var server = new MockNntpServer();
        server.Articles["a@test"] = YencTestEncoder.Encode([1, 2, 3], "a.bin");

        using var client = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 5));

        for (var i = 0; i < 5; i++)
        {
            var stat = await client.StatAsync("a@test", CancellationToken.None);
            Assert.True(stat.ArticleExists);
        }

        Assert.Equal(1, server.MaxObservedConnections);
        Assert.Equal(1, client.LiveConnections);
    }

    [Fact]
    public async Task MultiProvider_FallsBackToBackupProvider_OnMissingArticle()
    {
        var data = YencTestEncoder.LcgBytes(3, 5_000);

        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();
        backup.Articles["only-on-backup@test"] = YencTestEncoder.Encode(data, "f.bin");

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, 2, priority: 0, name: "primary"),
            ProviderFor(backup, 2, priority: 1, name: "backup"),
        ]);

        var response = await client.DecodedBodyAsync("only-on-backup@test", CancellationToken.None);
        await using var stream = response.Stream;
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(data, ms.ToArray());
        Assert.True(primary.CommandsServed > 0); // primary was tried first
    }

    [Fact]
    public async Task MultiProvider_MissingEverywhere_Returns430Response()
    {
        await using var primary = new MockNntpServer();
        await using var backup = new MockNntpServer();

        using var client = UsenetStreamingClient.Create([
            ProviderFor(primary, 2, priority: 0),
            ProviderFor(backup, 2, priority: 1),
        ]);

        var stat = await client.StatAsync("nowhere@test", CancellationToken.None);
        Assert.False(stat.ArticleExists);
    }

    [Fact]
    public async Task MultiProvider_DisabledProvidersAreSkipped()
    {
        await using var enabled = new MockNntpServer();
        enabled.Articles["x@test"] = YencTestEncoder.Encode([7], "x.bin");

        var disabledProvider = new UsenetProvider
        {
            Name = "disabled",
            Host = "203.0.113.1", // unroutable TEST-NET address; would hang if used
            Port = 119,
            UseSsl = false,
            Type = UsenetProviderType.Disabled,
        };

        using var client = UsenetStreamingClient.Create([
            disabledProvider,
            ProviderFor(enabled, 2, priority: 5),
        ]);

        var stat = await client.StatAsync("x@test", CancellationToken.None);
        Assert.True(stat.ArticleExists);
    }

    [Fact]
    public async Task ConnectionPool_FactoryFailure_ReleasesPermit()
    {
        var attempts = 0;
        await using var pool = new ConnectionPool<object>(1, _ =>
        {
            attempts++;
            throw new InvalidOperationException("factory boom");
        });

        for (var i = 0; i < 3; i++)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(
                () => pool.GetConnectionLockAsync(SemaphorePriority.High));
        }

        Assert.Equal(3, attempts); // the permit was released each time, no deadlock
    }
}
