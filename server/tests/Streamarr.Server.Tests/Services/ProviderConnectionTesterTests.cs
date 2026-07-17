using Streamarr.Server.Config;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Services;

public sealed class ProviderConnectionTesterTests
{
    [Fact]
    public async Task Probe_RejectsAnUnsuccessfulAuthenticationResponse()
    {
        var fake = new FakeNntpClient
        {
            AuthenticationResponse = new NntpResponse
            {
                ResponseCode = 481,
                ResponseMessage = "481 rejected",
            },
        };
        var tester = new ProviderConnectionTester(() => fake);

        var result = await tester.ProbeAsync(new UsenetProvider
        {
            Name = "test",
            Host = "news.example",
            Port = 563,
            UseSsl = true,
            Username = "user",
            Password = "bad",
            MaxConnections = 1,
        }, CancellationToken.None);

        Assert.False(result.Ok);
        Assert.Contains("481", result.Error);
    }
}

public sealed class ProviderSpeedTesterTests(ITestOutputHelper output)
{
    [Fact]
    public async Task SpeedTest_AutomaticallyDiscoversAndTransfersARecentArticle()
    {
        await using var server = new MockNntpServer { RequireAuth = true };
        server.Articles["speed-auto@test"] = YencTestEncoder.Encode(
            YencTestEncoder.LcgBytes(93, 128 * 1024),
            "speed.bin");
        using var tester = new ProviderSpeedTester
        {
            MaximumDownloadedBytes = 64 * 1024 * 1024,
        };

        var result = await tester.TestAsync(new UsenetProvider
        {
            Name = "test",
            Host = server.Host,
            Port = server.Port,
            UseSsl = false,
            Username = server.Username,
            Password = server.Password,
            MaxConnections = 2,
        }, messageId: null, durationSeconds: 15, CancellationToken.None);

        Assert.True(result.Success, result.Error);
        Assert.Equal("automatic", result.ArticleSource);
        Assert.Equal(2, result.ConnectionsUsed);
        Assert.True(result.BytesDownloaded >= 64 * 1024 * 1024);
        Assert.True(result.MegabitsPerSecond > 0);
        Assert.InRange(
            Math.Abs(result.RecommendedVideoBitrateMbps - result.MegabitsPerSecond * 0.70),
            0,
            0.02);
        output.WriteLine(
            "Loopback NNTP: {0:F2} Mbps ({1:F2} MB/s), {2:F2} Mbps recommended video, " +
            "{3} MiB in {4} ms over {5} connections, tier {6}",
            result.MegabitsPerSecond,
            result.MegabytesPerSecond,
            result.RecommendedVideoBitrateMbps,
            result.BytesDownloaded / 1024d / 1024d,
            result.DurationMilliseconds,
            result.ConnectionsUsed,
            result.StreamingTier);
    }
}
