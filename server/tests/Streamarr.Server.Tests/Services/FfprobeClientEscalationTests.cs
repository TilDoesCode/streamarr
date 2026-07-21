using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Regression guard for the TTFF fix: the escalated ffprobe pass must never (a) block
/// time-to-first-frame for the full FfprobeTimeoutSeconds, nor (b) discard the codec streams
/// the fast pass already read — losing those would push the player into a full re-encode.
/// </summary>
public sealed class FfprobeClientEscalationTests
{
    private static readonly FfprobeResult StreamsNoDuration = new()
    {
        RunTimeTicks = null,
        MediaStreams = [new MediaStreamInfo { Type = "Video", Codec = "h264" }],
    };

    private static readonly FfprobeResult StreamsWithDuration = new()
    {
        RunTimeTicks = 6_000_000_000,
        MediaStreams = [new MediaStreamInfo { Type = "Video", Codec = "h264" }],
    };

    [Fact]
    public async Task Escalation_ThatFindsNoStreams_KeepsFastPathStreams()
    {
        var options = Defaults();
        var probe = new StubFfprobe(options, probeSize =>
            probeSize >= options.FfprobeEscalatedProbeSizeBytes
                ? new FfprobeResult { RunTimeTicks = null, MediaStreams = [] } // escalation reads a torn header
                : StreamsNoDuration);

        var result = await probe.ProbeAsync("http://loopback/stream", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Single(result!.MediaStreams); // fast-path codec info preserved, not blanked
    }

    [Fact]
    public async Task Escalation_ThatSucceeds_IsPreferredForDuration()
    {
        var options = Defaults();
        var probe = new StubFfprobe(options, probeSize =>
            probeSize >= options.FfprobeEscalatedProbeSizeBytes ? StreamsWithDuration : StreamsNoDuration);

        var result = await probe.ProbeAsync("http://loopback/stream", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(6_000_000_000, result!.RunTimeTicks);
    }

    [Fact]
    public async Task Escalation_ThatStalls_IsBoundedAndFallsBackToFastStreams()
    {
        var options = Defaults();
        options.FfprobeTimeoutSeconds = 60;         // the old blocking ceiling
        options.FfprobeEscalatedTimeoutSeconds = 1; // the new bounded escalation budget
        var probe = new StubFfprobe(
            options,
            probeSize => probeSize >= options.FfprobeEscalatedProbeSizeBytes ? StreamsWithDuration : StreamsNoDuration,
            escalatedDelay: TimeSpan.FromSeconds(30)); // a provider that stalls the escalation

        var stopwatch = Stopwatch.StartNew();
        var result = await probe.ProbeAsync("http://loopback/stream", CancellationToken.None);
        stopwatch.Stop();

        Assert.NotNull(result);
        Assert.Single(result!.MediaStreams);                       // fast streams preserved
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(15),  // nowhere near the 60s ceiling
            $"escalation was not bounded: {stopwatch.Elapsed.TotalSeconds:F1}s");
    }

    private static StreamarrOptions Defaults() => new()
    {
        FfprobeProbeSizeBytes = 1024 * 1024,
        FfprobeAnalyzeDurationMs = 2_000,
        FfprobeEscalatedProbeSizeBytes = 5 * 1024 * 1024,
        FfprobeEscalatedAnalyzeDurationMs = 5_000,
        FfprobeEscalatedTimeoutSeconds = 8,
        FfprobeTimeoutSeconds = 60,
        MaxConcurrentFfprobe = 2,
    };

    private sealed class StubFfprobe(
        StreamarrOptions options,
        Func<int, FfprobeResult?> byProbeSize,
        TimeSpan escalatedDelay = default)
        : FfprobeClient(Microsoft.Extensions.Options.Options.Create(options), NullLogger<FfprobeClient>.Instance)
    {
        protected override async Task<FfprobeResult?> ProbeCoreAsync(
            string url, int probeSizeBytes, int analyzeDurationMs, CancellationToken ct)
        {
            if (probeSizeBytes >= options.FfprobeEscalatedProbeSizeBytes && escalatedDelay > TimeSpan.Zero)
                await Task.Delay(escalatedDelay, ct); // honors the bounded escalation token
            return byProbeSize(probeSizeBytes);
        }
    }
}
