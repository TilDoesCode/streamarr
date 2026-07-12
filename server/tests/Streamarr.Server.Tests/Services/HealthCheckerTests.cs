using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public class HealthCheckerTests
{
    private static HealthChecker Checker(FakeNntpClient client, int sampleCount = 24, double deadRatio = 0.5)
        => new(
            client,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                HealthCheck = new HealthCheckOptions
                {
                    SampleCount = sampleCount,
                    Concurrency = 4,
                    DeadMissingRatio = deadRatio,
                },
            }),
            NullLogger<HealthChecker>.Instance);

    private static string[] Segments(int count) =>
        Enumerable.Range(1, count).Select(i => $"seg{i}@test").ToArray();

    [Fact]
    public async Task AllSegmentsPresent_IsReady()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments);

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Ready, result.Health);
        Assert.Equal("ready", result.StatusLabel);
        Assert.Equal(8, result.SampledCount);
        Assert.Equal(0, result.MissingCount);
    }

    [Fact]
    public async Task FewMissingSegments_IsDegraded()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments.Where(s => s != "seg5@test"));

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Degraded, result.Health);
        Assert.Equal("degraded", result.StatusLabel);
        Assert.Equal(1, result.MissingCount);
    }

    [Fact]
    public async Task MostSegmentsMissing_IsDead()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments.Take(2));

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Dead, result.Health);
        Assert.Equal("dead", result.StatusLabel);
        Assert.Equal(6, result.MissingCount);
    }

    [Fact]
    public async Task NoSegments_IsDead()
    {
        var result = await Checker(new FakeNntpClient()).CheckAsync([], CancellationToken.None);
        Assert.Equal(ReleaseHealth.Dead, result.Health);
    }

    [Fact]
    public async Task LargeFiles_AreSampled_NotFullyScanned()
    {
        var segments = Segments(1000);
        var client = new FakeNntpClient(segments);

        var result = await Checker(client, sampleCount: 24).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(24, result.SampledCount);
        Assert.Equal(24, client.StattedSegments.Count);
        // the spread covers the whole file, not just its head
        Assert.Contains("seg1@test", client.StattedSegments);
        Assert.Contains("seg1000@test", client.StattedSegments);
    }

    [Fact]
    public void SampleEvenly_SmallInput_ReturnsEverything()
    {
        var segments = Segments(5);
        Assert.Equal(segments, HealthChecker.SampleEvenly(segments, 24));
    }

    [Fact]
    public void SampleEvenly_NeverDuplicates()
    {
        var segments = Segments(25);
        var sample = HealthChecker.SampleEvenly(segments, 24);
        Assert.Equal(sample.Distinct().Count(), sample.Count);
        Assert.Equal(segments[0], sample[0]);
        Assert.Equal(segments[^1], sample[^1]);
    }
}
