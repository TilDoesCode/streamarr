using System.Collections.Concurrent;
using System.Globalization;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

public sealed record TranscodingSample(
    string Id,
    string Title,
    string Description,
    string FileName,
    double DurationSeconds,
    string VideoSummary,
    string AudioSummary,
    IReadOnlyList<string> RequiredEncoders);

public enum SampleState
{
    Missing,
    Generating,
    Ready,
    Failed,
    Unsupported,
}

public sealed record SampleStatus(TranscodingSample Sample, SampleState State, double Progress, long? SizeBytes, string? Error);

/// <summary>Deterministic synthetic test media generated with ffmpeg on first use and cached in the data volume.</summary>
public sealed class TranscodingSampleLibrary(
    TranscodingWorkspace workspace,
    FfmpegCapabilityService capabilities,
    IOptions<TranscodingOptions> options,
    ILogger<TranscodingSampleLibrary> logger)
{
    private const string Sine = "sine=frequency=440:beep_factor=4:sample_rate=48000";

    public static readonly IReadOnlyList<TranscodingSample> Catalog =
    [
        new("h264-1080p-ac3", "1080p H.264 · Dolby Digital 5.1",
            "The most common Usenet WEB-DL shape. Browsers cannot play AC-3 or MKV reliably, so this needs the server.",
            "h264-1080p-ac3.mkv", 30, "H.264 High · 1920×1080 · 23.976 fps · 8-bit SDR · ~6 Mbps", "AC-3 5.1 · 384 kbps",
            ["libx264", "ac3"]),
        new("h264-720p-aac", "720p H.264 · AAC stereo (MP4)",
            "Browser-compatible baseline. Useful to compare direct play against a transcode of the same content.",
            "h264-720p-aac.mp4", 30, "H.264 High · 1280×720 · 25 fps · 8-bit SDR · ~3 Mbps", "AAC-LC stereo · 160 kbps",
            ["libx264", "aac"]),
        new("hevc-1080p-10bit", "1080p HEVC Main10 · E-AC-3 5.1",
            "Typical x265 release. Exercises 10-bit HEVC hardware decoding and 10→8-bit conversion.",
            "hevc-1080p-10bit.mkv", 30, "HEVC Main10 · 1920×1080 · 23.976 fps · 10-bit SDR · ~4 Mbps", "E-AC-3 5.1 · 640 kbps",
            ["libx265", "eac3"]),
        new("hevc-2160p-hdr10", "4K HEVC HDR10 · E-AC-3 5.1",
            "The worst case: 4K 10-bit decode, downscaling and HDR→SDR tone mapping in one pipeline.",
            "hevc-2160p-hdr10.mkv", 12, "HEVC Main10 · 3840×2160 · 23.976 fps · HDR10 (PQ, BT.2020) · ~12 Mbps", "E-AC-3 5.1 · 640 kbps",
            ["libx265", "eac3"]),
        new("mpeg2-576i", "576i MPEG-2 · AC-3 stereo (DVD style)",
            "Interlaced standard-definition video. Verifies deinterlacing and SD scaling.",
            "mpeg2-576i.mkv", 20, "MPEG-2 · 720×576 · 25i (top field first) · ~5 Mbps", "AC-3 stereo · 192 kbps",
            ["mpeg2video", "ac3"]),
        new("av1-1080p-opus", "1080p AV1 10-bit · Opus 5.1",
            "Modern AV1 release. Only GPUs from ~2021 decode AV1 in hardware.",
            "av1-1080p-opus.mkv", 20, "AV1 Main · 1920×1080 · 24 fps · 10-bit SDR · ~3 Mbps", "Opus 5.1 · 256 kbps",
            ["libsvtav1", "libopus"]),
    ];

    private readonly ConcurrentDictionary<string, (SampleState State, double Progress, string? Error)> _states = new();
    private readonly ConcurrentDictionary<string, Task> _generations = new();

    public static TranscodingSample? Find(string id) => Catalog.FirstOrDefault(s => s.Id == id);

    public string PathOf(TranscodingSample sample) => Path.Combine(workspace.SamplesRoot, sample.FileName);

    public async Task<IReadOnlyList<SampleStatus>> ListAsync(CancellationToken ct)
    {
        var caps = await capabilities.GetAsync(ct);
        return Catalog.Select(sample => Status(sample, caps)).ToList();
    }

    public SampleStatus Status(TranscodingSample sample, FfmpegCapabilities caps)
    {
        var path = PathOf(sample);
        if (File.Exists(path))
            return new SampleStatus(sample, SampleState.Ready, 1, new FileInfo(path).Length, null);
        if (_states.TryGetValue(sample.Id, out var state) && state.State is SampleState.Generating or SampleState.Failed)
            return new SampleStatus(sample, state.State, state.Progress, null, state.Error);
        var missing = sample.RequiredEncoders.Where(e => !caps.Encoders.Contains(e)).ToList();
        return missing.Count > 0
            ? new SampleStatus(sample, SampleState.Unsupported, 0, null, $"This ffmpeg build lacks: {string.Join(", ", missing)}.")
            : new SampleStatus(sample, SampleState.Missing, 0, null, null);
    }

    /// <summary>Starts (or joins) generation in the background; returns immediately.</summary>
    public async Task<SampleStatus> EnsureStartedAsync(TranscodingSample sample, CancellationToken ct)
    {
        var caps = await capabilities.GetAsync(ct);
        var status = Status(sample, caps);
        if (status.State is SampleState.Ready or SampleState.Unsupported or SampleState.Generating)
            return status;
        _ = _generations.GetOrAdd(sample.Id, _ =>
        {
            _states[sample.Id] = (SampleState.Generating, 0, null);
            return Task.Run(() => GenerateAsync(sample, caps));
        });
        return Status(sample, caps);
    }

    /// <summary>Generates if needed and waits until the file exists.</summary>
    public async Task<string> EnsureReadyAsync(TranscodingSample sample, CancellationToken ct)
    {
        var status = await EnsureStartedAsync(sample, ct);
        if (status.State == SampleState.Unsupported)
            throw new TranscodeException("sample_unsupported", status.Error ?? "The sample cannot be generated here.", 422);
        if (_generations.TryGetValue(sample.Id, out var running))
            await running.WaitAsync(ct);
        var path = PathOf(sample);
        if (!File.Exists(path))
        {
            var error = _states.TryGetValue(sample.Id, out var s) ? s.Error : null;
            throw new TranscodeException("sample_failed", error ?? "The sample could not be generated.", 500);
        }
        return path;
    }

    private async Task GenerateAsync(TranscodingSample sample, FfmpegCapabilities caps)
    {
        _states[sample.Id] = (SampleState.Generating, 0, null);
        Directory.CreateDirectory(workspace.SamplesRoot);
        var final = PathOf(sample);
        var partial = Path.Combine(workspace.SamplesRoot, $".{Path.GetFileNameWithoutExtension(sample.FileName)}.partial{Path.GetExtension(sample.FileName)}");
        try
        {
            var args = BuildArguments(sample, caps, partial);
            logger.LogInformation("Generating transcoding sample {Sample}", sample.Id);
            var result = await FfmpegRun.ExecuteAsync(
                options.Value.FfmpegPath,
                args,
                TimeSpan.FromMinutes(20),
                (seconds, _) => _states[sample.Id] = (SampleState.Generating, Math.Clamp(seconds / sample.DurationSeconds, 0, 0.99), null),
                CancellationToken.None);
            if (result.ExitCode != 0 || !File.Exists(partial))
                throw new InvalidOperationException(result.TimedOut ? "Generation timed out." : result.StandardErrorTail);
            File.Move(partial, final, overwrite: true);
            _states[sample.Id] = (SampleState.Ready, 1, null);
            logger.LogInformation("Generated transcoding sample {Sample} in {Seconds:0.0}s", sample.Id, result.Elapsed.TotalSeconds);
        }
        catch (Exception e)
        {
            logger.LogWarning("Generating transcoding sample {Sample} failed: {Error}", sample.Id, e.Message);
            _states[sample.Id] = (SampleState.Failed, 0, TranscodeRedaction.Tail(e.Message, 4));
            try
            {
                File.Delete(partial);
            }
            catch (IOException)
            {
            }
        }
        finally
        {
            _generations.TryRemove(sample.Id, out _);
        }
    }

    internal static IReadOnlyList<string> BuildArguments(TranscodingSample sample, FfmpegCapabilities caps, string output)
    {
        var d = sample.DurationSeconds.ToString(CultureInfo.InvariantCulture);
        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-y" };
        switch (sample.Id)
        {
            case "h264-1080p-ac3":
                args.AddRange(Inputs($"testsrc2=size=1920x1080:rate=24000/1001:duration={d},noise=alls=6:allf=t", d));
                args.AddRange(Surround("-c:a", "ac3", "-b:a", "384k"));
                args.AddRange(["-c:v", "libx264", "-preset", "veryfast", "-b:v", "6M", "-maxrate", "8M", "-bufsize", "12M",
                    "-g", "48", "-keyint_min", "24", "-pix_fmt", "yuv420p", "-profile:v", "high"]);
                break;
            case "h264-720p-aac":
                args.AddRange(Inputs($"testsrc2=size=1280x720:rate=25:duration={d},noise=alls=5:allf=t", d));
                args.AddRange(["-filter_complex", "[1:a]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"]);
                args.AddRange(["-c:v", "libx264", "-preset", "veryfast", "-b:v", "3M", "-maxrate", "4M", "-bufsize", "6M",
                    "-g", "50", "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart"]);
                break;
            case "hevc-1080p-10bit":
                args.AddRange(Inputs($"testsrc2=size=1920x1080:rate=24000/1001:duration={d},noise=alls=5:allf=t,format=yuv420p10le", d));
                args.AddRange(Surround("-c:a", "eac3", "-b:a", "640k"));
                args.AddRange(["-c:v", "libx265", "-preset", "ultrafast", "-b:v", "4M", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
                    "-x265-params", "log-level=error:keyint=96:min-keyint=24"]);
                break;
            case "hevc-2160p-hdr10":
                var pq = caps.Filters.Contains("zscale")
                    ? "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt2020:t=smpte2084:m=bt2020nc:r=tv:npl=100,format=yuv420p10le,scale=3840:2160:flags=bicubic"
                    : "format=yuv420p10le,scale=3840:2160:flags=bicubic";
                args.AddRange(Inputs($"testsrc2=size=960x540:rate=24000/1001:duration={d},noise=alls=8:allf=t,{pq}", d));
                args.AddRange(Surround("-c:a", "eac3", "-b:a", "640k"));
                args.AddRange(["-c:v", "libx265", "-preset", "ultrafast", "-b:v", "12M", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
                    "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
                    "-x265-params",
                    "log-level=error:keyint=96:min-keyint=24:hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400"]);
                break;
            case "mpeg2-576i":
                args.AddRange(Inputs($"testsrc2=size=720x576:rate=50:duration={d},noise=alls=6:allf=t,interlace=scan=tff:lowpass=complex", d));
                args.AddRange(["-filter_complex", "[1:a]pan=stereo|c0=c0|c1=c0[a]", "-map", "0:v", "-map", "[a]", "-c:a", "ac3", "-b:a", "192k"]);
                args.AddRange(["-c:v", "mpeg2video", "-flags", "+ilme+ildct", "-top", "1", "-b:v", "5M", "-maxrate", "8M",
                    "-bufsize", "1835k", "-g", "12", "-aspect", "16:9"]);
                break;
            case "av1-1080p-opus":
                args.AddRange(Inputs($"testsrc2=size=1920x1080:rate=24:duration={d},noise=alls=5:allf=t,format=yuv420p10le", d));
                args.AddRange(["-filter_complex",
                    "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]", "-map", "0:v", "-map", "[a]",
                    "-c:a", "libopus", "-b:a", "256k", "-mapping_family", "1"]);
                args.AddRange(["-c:v", "libsvtav1", "-preset", "12", "-b:v", "3M", "-g", "96", "-pix_fmt", "yuv420p10le"]);
                break;
            default:
                throw new ArgumentException($"Unknown sample '{sample.Id}'.");
        }
        args.AddRange(["-t", d, output]);
        return args;
    }

    private static string[] Inputs(string video, string duration)
        => ["-f", "lavfi", "-i", video, "-f", "lavfi", "-i", $"{Sine}:duration={duration}"];

    private static string[] Surround(params string[] codec)
        => ["-filter_complex", "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]", "-map", "0:v", "-map", "[a]", .. codec];
}
