using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Tests.Services;

public class HealthCheckerTests
{
    private static HealthChecker Checker(
        FakeNntpClient client,
        int sampleCount = 24,
        int startupSampleCount = 0,
        double deadRatio = 0.5,
        int concurrency = 4,
        int connectionBudget = 20,
        SegmentCache? segmentCache = null)
        => new(
            client,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                HealthCheck = new HealthCheckOptions
                {
                    SampleCount = sampleCount,
                    StartupSampleCount = startupSampleCount,
                    StartupBodyConcurrency = Math.Min(concurrency, 4),
                    Concurrency = concurrency,
                    DeadMissingRatio = deadRatio,
                },
                ConnectionBudget = connectionBudget,
            }),
            NullLogger<HealthChecker>.Instance,
            segmentCache);

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
        Assert.Equal(0, result.ConfirmedMissingCount);
        Assert.Equal(0, result.IndeterminateCount);
    }

    [Fact]
    public async Task OneConfirmedMissingMediaSegment_IsDead()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments.Where(s => s != "seg5@test"));

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Dead, result.Health);
        Assert.Equal("dead", result.StatusLabel);
        Assert.Equal(1, result.ConfirmedMissingCount);
        Assert.Equal(0, result.IndeterminateCount);
    }

    [Fact]
    public async Task OneIndeterminateStat_IsDegraded()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments);
        client.FailingSegments.Add("seg5@test");

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Degraded, result.Health);
        Assert.Equal("degraded", result.StatusLabel);
        Assert.Equal(0, result.ConfirmedMissingCount);
        Assert.Equal(1, result.IndeterminateCount);
    }

    [Fact]
    public async Task MostSegmentsMissing_IsDead()
    {
        var segments = Segments(8);
        var client = new FakeNntpClient(segments.Take(2));

        var result = await Checker(client).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Dead, result.Health);
        Assert.Equal("dead", result.StatusLabel);
        Assert.Equal(6, result.ConfirmedMissingCount);
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

    [Fact]
    public void SampleEvenly_OneSample_ReturnsFirstWithoutDividingByZero()
    {
        Assert.Equal(["s0"], HealthChecker.SampleEvenly(["s0", "s1", "s2"], 1));
        Assert.Empty(HealthChecker.SampleEvenly(["s0", "s1"], 0));
    }

    [Fact]
    public async Task FuNStyleEarlyHole_IsIncludedInStartupSampleAndClassifiedDead()
    {
        var segments = Segments(1725);
        var client = new FakeNntpClient(segments);
        client.MissingBodySegments.Add("seg41@test");
        using var cache = new SegmentCache(1024 * 1024);

        var result = await Checker(client, sampleCount: 24, startupSampleCount: 64, segmentCache: cache)
            .CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Dead, result.Health);
        Assert.Equal(87, result.SampledCount);
        Assert.Equal(1, result.ConfirmedMissingCount);
        Assert.Contains("seg41@test", client.BodyRequestedSegments);
        Assert.DoesNotContain("seg41@test", client.StattedSegments);
        Assert.InRange(client.BodyRequestedSegments.Count, 41, 45);
        Assert.True(cache.TryGet("seg1@test", out _));
    }

    [Fact]
    public async Task SuccessfulStartupBodyVerification_WarmsCacheForTheNextReader()
    {
        var segments = Segments(9);
        var client = new FakeNntpClient(segments);
        using var cache = new SegmentCache(1024 * 1024);
        var checker = Checker(
            client,
            sampleCount: 1,
            startupSampleCount: 8,
            segmentCache: cache);

        var first = await checker.CheckAsync(segments, CancellationToken.None);
        var bodyRequestsAfterFirstCheck = client.BodyRequestedSegments.Count;
        var second = await checker.CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Ready, first.Health);
        Assert.Equal(ReleaseHealth.Ready, second.Health);
        Assert.Equal(8, bodyRequestsAfterFirstCheck);
        Assert.Equal(bodyRequestsAfterFirstCheck, client.BodyRequestedSegments.Count);
        Assert.All(segments[..8], segmentId => Assert.True(cache.TryGet(segmentId, out _)));
        Assert.DoesNotContain(segments[..8], segmentId => client.StattedSegments.Contains(segmentId));
    }

    [Fact]
    public async Task StartupBodyTransportFailure_IsDeadInsteadOfAdmittingAnUnverifiedRelease()
    {
        var segments = Segments(1725);
        var client = new FakeNntpClient(segments);
        client.FailingBodySegments.Add("seg41@test");

        var result = await Checker(client, sampleCount: 24, startupSampleCount: 64)
            .CheckAsync(segments, CancellationToken.None);

        Assert.Equal(ReleaseHealth.Dead, result.Health);
        Assert.Equal(0, result.ConfirmedMissingCount);
        Assert.Equal(1, result.IndeterminateCount);
        Assert.Contains("seg41@test", client.BodyRequestedSegments);
    }

    [Fact]
    public void SelectSamples_CombinesStartupPrefixWithWholeFileSpreadWithoutDuplicates()
    {
        var segments = Segments(1725);

        var sample = HealthChecker.SelectSamples(segments, evenlySpreadSamples: 24, startupSamples: 64);

        Assert.Equal(87, sample.Count);
        Assert.Equal(sample.Distinct().Count(), sample.Count);
        Assert.Equal(segments[..64], sample.Take(64));
        Assert.Equal("seg1725@test", sample[^1]);
    }

    [Fact]
    public async Task Concurrency_UsesConfiguredProviderBudgetWithoutChangingSampleSet()
    {
        var segments = Segments(24);
        var client = new FakeNntpClient(segments) { StatDelay = TimeSpan.FromMilliseconds(20) };

        var result = await Checker(
            client,
            concurrency: 100,
            connectionBudget: 12).CheckAsync(segments, CancellationToken.None);

        Assert.Equal(24, result.SampledCount);
        Assert.Equal(12, client.MaxConcurrentStats);
    }

    [Fact]
    public void StartupDefaults_FillTheConnectionBudget()
    {
        var options = new StreamarrOptions();
        Assert.Equal(20, options.ConnectionWarmupCount);
        Assert.Equal(20, options.RarMaterializationConcurrency);
        Assert.Equal(20, options.HealthCheck.Concurrency);
        Assert.Equal(64, options.HealthCheck.StartupSampleCount);
        Assert.Equal(4, options.HealthCheck.StartupBodyConcurrency);
        Assert.Equal(20, NntpConnectionWarmupService.EffectiveWarmupCount(options));
    }
}
