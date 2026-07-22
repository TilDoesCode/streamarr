using System.Diagnostics;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class StreamPacerTests
{
    [Fact]
    public async Task WithinBurst_NeverDelays_AndNeverEngages()
    {
        var engaged = false;
        var pacer = new StreamPacer(burstBytes: 1024 * 1024, sustainBytesPerSecond: 1024, () => engaged = true);

        var clock = Stopwatch.StartNew();
        for (var i = 0; i < 16; i++)
            await pacer.PaceAsync(64 * 1024, CancellationToken.None); // exactly the burst

        Assert.False(engaged);
        Assert.True(clock.ElapsedMilliseconds < 200, $"burst reads must not be paced (took {clock.ElapsedMilliseconds}ms)");
    }

    [Fact]
    public async Task BeyondBurst_EngagesOnce_AndHoldsSustainRate()
    {
        var engagedCount = 0;
        // 64 KiB burst, then 256 KiB/s sustain.
        var pacer = new StreamPacer(burstBytes: 64 * 1024, sustainBytesPerSecond: 256 * 1024, () => engagedCount++);

        await pacer.PaceAsync(64 * 1024, CancellationToken.None);   // spends the burst
        await pacer.PaceAsync(16 * 1024, CancellationToken.None);   // crosses it -> engages, no delay yet
        Assert.Equal(1, engagedCount);

        // 128 KiB beyond the burst at 256 KiB/s should take ~>=350ms wall time from engagement
        // (16 KiB were already granted at engagement time).
        var clock = Stopwatch.StartNew();
        for (var i = 0; i < 8; i++)
            await pacer.PaceAsync(16 * 1024, CancellationToken.None);
        clock.Stop();

        Assert.Equal(1, engagedCount); // engaged exactly once
        Assert.InRange(clock.ElapsedMilliseconds, 300, 5_000);
    }

    [Fact]
    public async Task PaceAsync_HonorsCancellation()
    {
        var pacer = new StreamPacer(burstBytes: 1, sustainBytesPerSecond: 1);
        await pacer.PaceAsync(1024, CancellationToken.None); // engage
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await pacer.PaceAsync(1024 * 1024, cts.Token));
    }

    [Fact]
    public void HighBitrateMedia_RaisesSustainRateAboveRealtime()
    {
        const long sizeBytes = 12L * 1024 * 1024 * 1024;
        const long startupBurstBytes = 96L * 1024 * 1024;
        var runTimeTicks = TimeSpan.FromMinutes(10).Ticks;
        const double configuredFloor = 6d * 1024 * 1024;

        var selected = StreamPacer.SelectSustainBytesPerSecond(
            sizeBytes,
            runTimeTicks,
            configuredFloor);
        var averageMediaRate = sizeBytes / TimeSpan.FromMinutes(10).TotalSeconds;

        Assert.Equal(
            averageMediaRate * StreamPacer.RealtimeHeadroomMultiplier,
            selected,
            precision: 3);
        Assert.True(selected > configuredFloor);

        // This reproduces the reported freeze: with the old fixed ceiling, a remux consuming
        // at the media's average rate exhausts Core's startup lead after only a few seconds.
        var oldCeilingLeadSeconds = startupBurstBytes / (averageMediaRate - configuredFloor);
        Assert.InRange(oldCeilingLeadSeconds, 6, 7);
    }

    [Fact]
    public void LowBitrateOrUnknownDuration_KeepsConfiguredFloor()
    {
        const double configuredFloor = 6d * 1024 * 1024;

        var lowBitrate = StreamPacer.SelectSustainBytesPerSecond(
            sizeBytes: 600L * 1024 * 1024,
            runTimeTicks: TimeSpan.FromHours(1).Ticks,
            configuredFloor);
        var unknownDuration = StreamPacer.SelectSustainBytesPerSecond(
            sizeBytes: 12L * 1024 * 1024 * 1024,
            runTimeTicks: 0,
            configuredFloor);

        Assert.Equal(configuredFloor, lowBitrate);
        Assert.Equal(configuredFloor, unknownDuration);
    }
}
