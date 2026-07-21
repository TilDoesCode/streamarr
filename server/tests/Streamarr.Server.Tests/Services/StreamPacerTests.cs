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
}
