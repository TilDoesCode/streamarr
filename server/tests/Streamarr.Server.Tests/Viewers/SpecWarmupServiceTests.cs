using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

public class SpecWarmupServiceTests
{
    private static SpecWarmupService Service(SpecWarmupOptions warmup)
        => new(new ServiceCollection().BuildServiceProvider(), Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { SpecWarmup = warmup }),
            TimeProvider.System, NullLogger<SpecWarmupService>.Instance);

    [Fact]
    public async Task StopsAtTheDailyCap()
    {
        using var service = Service(new SpecWarmupOptions { DailyCap = 2 });
        await service.StartAsync(CancellationToken.None);

        service.Request(Enumerable.Range(1, 5).Select(i => $"tmdb-movie-{i}").Append("tmdb-tv-9-s01e02").Append("not-a-work"));
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (service.StartedToday < 2 && DateTime.UtcNow < deadline)
            await Task.Delay(20);
        await Task.Delay(200);

        Assert.Equal(2, service.StartedToday);
        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task OffMeansNoLookups()
    {
        using var service = Service(new SpecWarmupOptions { Enabled = false });
        await service.StartAsync(CancellationToken.None);

        service.Request(["tmdb-movie-1"]);
        await Task.Delay(100);

        Assert.False(service.Enabled);
        Assert.Equal(0, service.StartedToday);
    }

    [Theory]
    [InlineData("tmdb-movie-7", "movie:7")]
    [InlineData("tmdb-tv-7", "tv:7:first")]
    [InlineData("tmdb-tv-7-s02", "tv:7:2")]
    [InlineData("tmdb-tv-7-s02e05", "tv:7:2")]
    [InlineData("unmatched-movie-x", null)]
    public void TargetsGroupEpisodesBySeason(string workId, string? key) => Assert.Equal(key, SpecWarmupTarget.For(workId)?.Key);
}
