using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Usenet.Tests.Nntp;

public class GatedNntpClientTests
{
    private static UsenetProvider ProviderFor(MockNntpServer server, int maxConnections) => new()
    {
        Name = "mock",
        Host = server.Host,
        Port = server.Port,
        UseSsl = false,
        Username = server.Username,
        Password = server.Password,
        MaxConnections = maxConnections,
    };

    [Fact]
    public async Task Budget_CapsConcurrentConnections_AcrossParallelCommands()
    {
        var data = YencTestEncoder.LcgBytes(11, 20_000);
        await using var server = new MockNntpServer();
        for (var i = 0; i < 24; i++)
            server.Articles[$"seg{i}@test"] = YencTestEncoder.Encode(data, $"f{i}.bin");

        // provider alone would open up to 10 connections; the budget caps it at 2
        using var provider = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 10));
        using var gated = new GatedNntpClient(provider, new SemaphoreNntpGate(budget: 2));

        await Task.WhenAll(Enumerable.Range(0, 24).Select(async i =>
        {
            var response = await gated.StatAsync($"seg{i}@test", CancellationToken.None);
            Assert.True(response.ArticleExists);
        }));

        Assert.True(server.MaxObservedConnections <= 2,
            $"budget of 2 exceeded: {server.MaxObservedConnections} concurrent connections observed");
    }

    [Fact]
    public async Task Budget_HeldUntilBodyFullyRetrieved()
    {
        var data = YencTestEncoder.LcgBytes(12, 30_000);
        await using var server = new MockNntpServer();
        for (var i = 0; i < 8; i++)
            server.Articles[$"body{i}@test"] = YencTestEncoder.Encode(data, $"f{i}.bin");

        using var provider = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 8));
        using var gated = new GatedNntpClient(provider, new SemaphoreNntpGate(budget: 3));

        await Task.WhenAll(Enumerable.Range(0, 8).Select(async i =>
        {
            var response = await gated.DecodedBodyAsync($"body{i}@test", CancellationToken.None);
            await using var stream = response.Stream;
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
            Assert.Equal(data, ms.ToArray());
        }));

        Assert.True(server.MaxObservedConnections <= 3,
            $"budget of 3 exceeded: {server.MaxObservedConnections} concurrent connections observed");
    }

    [Fact]
    public async Task CountingGate_TracksTotalAndReturnsToZero()
    {
        var data = YencTestEncoder.LcgBytes(13, 10_000);
        await using var server = new MockNntpServer();
        server.Articles["count@test"] = YencTestEncoder.Encode(data, "f.bin");

        using var provider = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 2));
        var gate = new CountingNntpGate();
        using var gated = new GatedNntpClient(provider, gate);

        var stat = await gated.StatAsync("count@test", CancellationToken.None);
        Assert.True(stat.ArticleExists);

        var body = await gated.DecodedBodyAsync("count@test", CancellationToken.None);
        await using (var stream = body.Stream)
        {
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
        }

        Assert.Equal(2, gate.TotalCommands);

        // the BODY release fires from the connection's background reader; wait briefly
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (gate.InFlight != 0 && DateTime.UtcNow < deadline)
            await Task.Delay(10);
        Assert.Equal(0, gate.InFlight);
    }

    [Fact]
    public async Task Gate_ReleasedOnMissingArticle()
    {
        await using var server = new MockNntpServer();

        using var provider = UsenetStreamingClient.CreateProviderClient(ProviderFor(server, maxConnections: 2));
        using var gated = new GatedNntpClient(provider, new SemaphoreNntpGate(budget: 1));

        // both commands would deadlock on a leaked permit if failure paths did not release
        await Assert.ThrowsAnyAsync<Exception>(
            () => gated.DecodedBodyAsync("missing1@test", CancellationToken.None));
        await Assert.ThrowsAnyAsync<Exception>(
            () => gated.DecodedBodyAsync("missing2@test", CancellationToken.None));

        var stat = await gated.StatAsync("missing3@test", CancellationToken.None);
        Assert.False(stat.ArticleExists);
    }
}
