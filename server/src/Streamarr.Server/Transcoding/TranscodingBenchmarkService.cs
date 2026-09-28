using System.Globalization;
using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

public sealed record BenchmarkRequest(string SampleId, int MaxHeight, int BitrateKbps, HardwareAcceleration? Acceleration);

public enum BenchmarkState
{
    Queued,
    PreparingSample,
    Running,
    Completed,
    Failed,
}

public sealed record SegmentCheck(int Index, double StartSeconds, double DurationSeconds, bool StartsWithKeyframe, double DriftMs);

public sealed record BenchmarkResult
{
    public required string Verdict { get; init; }
    public required string Summary { get; init; }
    public double MediaSeconds { get; init; }
    public double WallSeconds { get; init; }
    public double Speed { get; init; }
    public double Fps { get; init; }
    public double CpuSeconds { get; init; }
    public double AverageCpuCores { get; init; }
    public double? TimeToFirstSegmentMs { get; init; }
    public double? SeekTimeToFirstSegmentMs { get; init; }
    public int Segments { get; init; }
    public int ExpectedSegments { get; init; }
    public bool KeyframesAligned { get; init; }
    public double MaxDriftMs { get; init; }
    public int? OutputBitrateKbps { get; init; }
    public int? OutputWidth { get; init; }
    public int? OutputHeight { get; init; }
    public bool HardwareFallbackDetected { get; init; }
    public IReadOnlyList<SegmentCheck> SegmentChecks { get; init; } = [];
    public IReadOnlyList<string> Warnings { get; init; } = [];
    public IReadOnlyList<string> Command { get; init; } = [];
    public string? Log { get; init; }
}

public sealed class BenchmarkRun
{
    public required string Id { get; init; }
    public required BenchmarkRequest Request { get; init; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? StartedAt { get; internal set; }
    public DateTimeOffset? FinishedAt { get; internal set; }
    public BenchmarkState State { get; internal set; }
    public double Progress { get; internal set; }
    public string? Error { get; internal set; }
    public TranscodePlan? Plan { get; internal set; }
    public SourceMediaInfo? Media { get; internal set; }
    public BenchmarkResult? Result { get; internal set; }
    public int ActiveTranscodesAtStart { get; internal set; }
}

/// <summary>Runs the live argument builder flat-out against a sample and grades speed, hardware use and segment alignment.</summary>
public sealed class TranscodingBenchmarkService(
    TranscodingSampleLibrary samples,
    SourceMediaProber prober,
    TranscodingSettingsService settingsService,
    FfmpegCapabilityService capabilityService,
    TranscodeSessionManager sessions,
    TranscodingWorkspace workspace,
    IOptions<TranscodingOptions> options,
    ILogger<TranscodingBenchmarkService> logger)
{
    private const int MaxRetained = 30;
    private readonly ConcurrentDictionary<string, BenchmarkRun> _runs = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _serial = new(1, 1);

    public IReadOnlyList<BenchmarkRun> Runs => _runs.Values.OrderByDescending(r => r.CreatedAt).ToList();

    public BenchmarkRun? Find(string id) => _runs.TryGetValue(id, out var run) ? run : null;

    public BenchmarkRun Start(BenchmarkRequest request)
    {
        if (TranscodingSampleLibrary.Find(request.SampleId) is null)
            throw new TranscodeException("unknown_sample", $"Unknown sample '{request.SampleId}'.", 404);
        var run = new BenchmarkRun { Id = Guid.NewGuid().ToString("N")[..12], Request = request, State = BenchmarkState.Queued };
        _runs[run.Id] = run;
        Trim();
        _ = Task.Run(() => ExecuteAsync(run));
        return run;
    }

    private async Task ExecuteAsync(BenchmarkRun run)
    {
        await _serial.WaitAsync();
        var scratch = string.Empty;
        try
        {
            run.StartedAt = DateTimeOffset.UtcNow;
            run.ActiveTranscodesAtStart = sessions.RunningJobs;
            var sample = TranscodingSampleLibrary.Find(run.Request.SampleId)!;
            run.State = BenchmarkState.PreparingSample;
            var path = await samples.EnsureReadyAsync(sample, CancellationToken.None);

            run.State = BenchmarkState.Running;
            var capabilities = await capabilityService.GetAsync(CancellationToken.None);
            var settings = settingsService.Current with { MaxHeight = run.Request.MaxHeight, MaxBitrateKbps = run.Request.BitrateKbps };
            if (run.Request.Acceleration is { } accel)
                settings = settings with { Acceleration = accel };
            var source = new TranscodeSource(TranscodeSource.SampleKind, path, false, sample.Title);
            var media = await prober.ProbeAsync(source, CancellationToken.None)
                        ?? throw new TranscodeException("probe_failed", "ffprobe could not read the sample.", 500);
            var plan = TranscodePlanner.Plan(media, ClientProfile.Default, new TranscodeLimits(), settings, capabilities);
            run.Plan = plan;
            run.Media = media;

            scratch = workspace.CreateScratchDirectory("benchmark");
            var timeline = SegmentTimeline.Create(plan.DurationSeconds, settings.SegmentLengthSeconds);
            var spec = new FfmpegJobSpec
            {
                Plan = plan,
                Source = source,
                Settings = settings,
                Capabilities = capabilities,
                OutputDirectory = scratch,
                JobTag = "bench",
                SegmentLength = timeline.SegmentLength,
            };
            var args = FfmpegArgumentBuilder.Build(spec);
            var firstSegment = Path.Combine(scratch, "0.m4s");
            var startedUtc = DateTime.UtcNow;
            var result = await FfmpegRun.ExecuteAsync(
                options.Value.FfmpegPath, args, TimeSpan.FromMinutes(5),
                (seconds, _) => run.Progress = Math.Clamp(seconds / plan.DurationSeconds, 0, 0.95),
                CancellationToken.None);
            var ttfs = WrittenAfter(firstSegment, startedUtc);

            if (result.ExitCode != 0)
            {
                run.Result = new BenchmarkResult
                {
                    Verdict = "failed",
                    Summary = result.TimedOut ? "The transcode timed out." : "ffmpeg failed with this configuration.",
                    WallSeconds = result.Elapsed.TotalSeconds,
                    Command = TranscodeRedaction.RedactArguments(args),
                    Log = result.StandardErrorTail,
                    HardwareFallbackDetected = FfmpegCapabilityProbe.HasHardwareFailure(result.StandardErrorTail),
                };
                run.State = BenchmarkState.Failed;
                run.Error = run.Result.Summary;
                return;
            }

            var seekTtfs = await MeasureSeekAsync(spec, timeline, scratch);
            run.Result = Grade(plan, timeline, result, ttfs, seekTtfs, scratch, args, run.ActiveTranscodesAtStart);
            run.State = BenchmarkState.Completed;
            run.Progress = 1;
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Transcoding benchmark {Id} failed", run.Id);
            run.State = BenchmarkState.Failed;
            run.Error = e is TranscodeException or TranscodePlanningException ? e.Message : $"{e.GetType().Name}: {e.Message}";
        }
        finally
        {
            run.FinishedAt = DateTimeOffset.UtcNow;
            if (scratch.Length > 0)
                TranscodingWorkspace.TryDelete(scratch);
            _serial.Release();
        }
    }

    private async Task<double?> MeasureSeekAsync(FfmpegJobSpec spec, SegmentTimeline timeline, string scratch)
    {
        if (timeline.Count < 3)
            return null;
        var seekDirectory = Path.Combine(scratch, "seek");
        Directory.CreateDirectory(seekDirectory);
        var start = timeline.Count / 2;
        var seekSpec = spec with
        {
            OutputDirectory = seekDirectory,
            JobTag = "seek",
            StartSegment = start,
            MaxInputSeconds = timeline.SegmentLength * 1.5,
        };
        var target = Path.Combine(seekDirectory, $"{start}.m4s");
        var startedUtc = DateTime.UtcNow;
        var result = await FfmpegRun.ExecuteAsync(
            options.Value.FfmpegPath, FfmpegArgumentBuilder.Build(seekSpec), TimeSpan.FromMinutes(2), null, CancellationToken.None);
        return result.ExitCode == 0 ? WrittenAfter(target, startedUtc) : null;
    }

    /// <summary>ffmpeg finishes a segment in a temp file and renames it, so the file's write time is when it became servable.</summary>
    private static double? WrittenAfter(string path, DateTime startedUtc)
        => File.Exists(path) ? Math.Max(0, (File.GetLastWriteTimeUtc(path) - startedUtc).TotalMilliseconds) : null;

    internal static BenchmarkResult Grade(
        TranscodePlan plan,
        SegmentTimeline timeline,
        FfmpegRunResult run,
        double? ttfs,
        double? seekTtfs,
        string directory,
        IReadOnlyList<string> args,
        int activeTranscodes)
    {
        var warnings = new List<string>(plan.Warnings);
        var checks = InspectSegments(directory, "init-bench.mp4", timeline, out var bytes, out var width, out var height);
        var mediaSeconds = plan.DurationSeconds;
        var wall = Math.Max(0.001, run.Elapsed.TotalSeconds);
        var speed = mediaSeconds / wall;
        var cores = run.CpuTime.TotalSeconds / wall;
        var aligned = checks.Count > 0 && checks.All(c => c.StartsWithKeyframe) && checks.All(c => Math.Abs(c.DriftMs) <= 200);
        var maxDrift = checks.Count == 0 ? 0 : checks.Max(c => Math.Abs(c.DriftMs));
        var fallback = FfmpegCapabilityProbe.HasHardwareFailure(run.StandardErrorTail);

        if (fallback)
            warnings.Add("ffmpeg reported a hardware initialisation failure; part of the pipeline fell back to software.");
        if (!aligned)
            warnings.Add(string.Create(CultureInfo.InvariantCulture, $"Segments are not aligned to the {timeline.SegmentLength:0}s keyframe grid (max drift {maxDrift:0} ms); seeking may be imprecise with this encoder."));
        if (checks.Count < timeline.Count)
            warnings.Add($"Only {checks.Count} of {timeline.Count} expected segments were produced.");
        if (activeTranscodes > 0)
            warnings.Add($"{activeTranscodes} live transcode(s) were running during the benchmark; the numbers are pessimistic.");

        var (verdict, summary) = speed switch
        {
            >= 2.0 => ("excellent", string.Create(CultureInfo.InvariantCulture, $"{speed:0.0}× realtime — roughly {Math.Max(1, (int)Math.Floor(speed * 0.8))} streams like this at once.")),
            >= 1.25 => ("good", string.Create(CultureInfo.InvariantCulture, $"{speed:0.0}× realtime — one stream plays smoothly; seeks settle quickly.")),
            >= 1.0 => ("marginal", string.Create(CultureInfo.InvariantCulture, $"{speed:0.00}× realtime — barely keeps up; seeks and a second stream will stall.")),
            _ => ("too-slow", string.Create(CultureInfo.InvariantCulture, $"{speed:0.00}× realtime — playback will buffer. Use hardware acceleration or a lower resolution.")),
        };

        return new BenchmarkResult
        {
            Verdict = verdict,
            Summary = summary,
            MediaSeconds = mediaSeconds,
            WallSeconds = wall,
            Speed = speed,
            Fps = run.Frames / wall,
            CpuSeconds = run.CpuTime.TotalSeconds,
            AverageCpuCores = cores,
            TimeToFirstSegmentMs = ttfs,
            SeekTimeToFirstSegmentMs = seekTtfs,
            Segments = checks.Count,
            ExpectedSegments = timeline.Count,
            KeyframesAligned = aligned,
            MaxDriftMs = maxDrift,
            OutputBitrateKbps = mediaSeconds > 0 ? (int)(bytes * 8 / mediaSeconds / 1000) : null,
            OutputWidth = width,
            OutputHeight = height,
            HardwareFallbackDetected = fallback,
            SegmentChecks = checks,
            Warnings = warnings,
            Command = TranscodeRedaction.RedactArguments(args),
            Log = run.StandardErrorTail,
        };
    }

    internal static List<SegmentCheck> InspectSegments(
        string directory, string initName, SegmentTimeline timeline, out long bytes, out int? width, out int? height)
    {
        bytes = 0;
        width = height = null;
        var checks = new List<SegmentCheck>();
        var initPath = Path.Combine(directory, initName);
        if (!File.Exists(initPath))
            return checks;
        var init = Fmp4.ParseInit(File.ReadAllBytes(initPath));
        if (init.Video is { Width: > 0 } track)
            (width, height) = (track.Width, track.Height);
        double? origin = null;
        for (var i = 0; i < timeline.Count; i++)
        {
            var path = Path.Combine(directory, $"{i}.m4s");
            if (!File.Exists(path))
                break;
            var data = File.ReadAllBytes(path);
            bytes += data.Length;
            var video = Fmp4.ParseSegment(data, init).Timings(init).FirstOrDefault(t => t.Handler == "vide");
            if (video is null)
                continue;
            origin ??= video.StartSeconds - timeline.StartOf(i);
            checks.Add(new SegmentCheck(i, video.StartSeconds, video.DurationSeconds, video.StartsWithKeyframe,
                (video.StartSeconds - origin.Value - timeline.StartOf(i)) * 1000));
        }
        return checks;
    }

    private void Trim()
    {
        foreach (var old in _runs.Values.OrderByDescending(r => r.CreatedAt).Skip(MaxRetained))
            _runs.TryRemove(old.Id, out _);
    }
}
