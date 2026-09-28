using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

/// <summary>Detects what the installed ffmpeg can do and proves each hardware path with real tiny encodes and decodes.</summary>
public sealed partial class FfmpegCapabilityProbe(
    IProcessRunner runner,
    IOptions<TranscodingOptions> options,
    TranscodingWorkspace workspace,
    IGpuDeviceEnumerator gpus,
    ILogger<FfmpegCapabilityProbe> logger,
    Func<HardwareAcceleration, bool>? platformSupports = null)
{
    private sealed record TestClip(string Codec, string Path, bool TenBit);

    private TimeSpan StepTimeout => TimeSpan.FromSeconds(Math.Max(5, options.Value.CapabilityProbeTimeoutSeconds));

    public async Task<FfmpegCapabilities> DetectAsync(TranscodingSettings settings, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        var ffmpeg = options.Value.FfmpegPath;
        var platform = await DetectPlatformAsync(ct);

        ProcessResult version;
        try
        {
            version = await runner.RunAsync(ffmpeg, ["-hide_banner", "-version"], StepTimeout, ct);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or FileNotFoundException or InvalidOperationException)
        {
            return FfmpegCapabilities.Missing(ffmpeg, $"ffmpeg could not be started from '{ffmpeg}': {e.Message}") with { Platform = platform };
        }
        if (!version.Succeeded)
            return FfmpegCapabilities.Missing(ffmpeg, $"'{ffmpeg} -version' exited with {version.ExitCode}.") with { Platform = platform };

        var (versionText, major) = ParseVersion(version.StandardOutput);
        var encoders = ParseCodecList((await Run(ffmpeg, ["-hide_banner", "-encoders"], ct)).StandardOutput);
        var decoders = ParseCodecList((await Run(ffmpeg, ["-hide_banner", "-decoders"], ct)).StandardOutput);
        var filters = ParseFilters((await Run(ffmpeg, ["-hide_banner", "-filters"], ct)).StandardOutput);
        var hwaccels = ParseHwAccels((await Run(ffmpeg, ["-hide_banner", "-hwaccels"], ct)).StandardOutput);
        var (ffprobeFound, ffprobeVersion) = await DetectFfprobeAsync(ct);

        var baseline = new FfmpegCapabilities
        {
            FfmpegFound = true,
            FfmpegPath = ffmpeg,
            Version = versionText,
            MajorVersion = major,
            FfprobeFound = ffprobeFound,
            FfprobeVersion = ffprobeVersion,
            Encoders = encoders,
            Decoders = decoders,
            Filters = filters,
            HwAccels = hwaccels,
            Platform = platform,
            DetectedAt = DateTimeOffset.UtcNow,
        };

        var scratch = workspace.CreateScratchDirectory("capability-probe");
        try
        {
            var clips = await GenerateClipsAsync(baseline, scratch, ct);
            var relative = await DetectKeyframeSemanticsAsync(baseline, clips, scratch, ct);
            var devices = await gpus.EnumerateAsync(ct);
            var accelerators = new List<AcceleratorCapability>();
            foreach (var kind in new[]
                     {
                         HardwareAcceleration.VideoToolbox, HardwareAcceleration.Vaapi,
                         HardwareAcceleration.Qsv, HardwareAcceleration.Nvenc,
                     })
            {
                accelerators.Add(await ProbeAcceleratorAsync(kind, baseline, settings, clips, devices, ct));
            }

            return baseline with
            {
                RelativeKeyframeExpressions = relative,
                Accelerators = accelerators,
                Devices = devices.Select(d => d with
                {
                    Checks = accelerators
                        .Where(a => a.DeviceChecks.ContainsKey(d.Id))
                        .ToDictionary(a => a.Kind, a => a.DeviceChecks[d.Id]),
                }).ToList(),
                Duration = watch.Elapsed,
            };
        }
        finally
        {
            TryDelete(scratch);
        }
    }

    private async Task<AcceleratorCapability> ProbeAcceleratorAsync(
        HardwareAcceleration kind,
        FfmpegCapabilities caps,
        TranscodingSettings settings,
        IReadOnlyList<TestClip> clips,
        IReadOnlyList<GpuDevice> devices,
        CancellationToken ct)
    {
        var platform = (platformSupports ?? HardwareProfiles.PlatformSupports)(kind);
        var h264Encoder = HardwareProfiles.EncoderName(kind, "h264");
        var hwaccel = HardwareProfiles.HwAccelName(kind);
        var compiled = caps.Encoders.Contains(h264Encoder) && hwaccel is not null && caps.HwAccels.Contains(hwaccel);
        var notes = new List<string>();
        var (devicePresent, device) = DeviceState(kind, settings, devices, notes);

        var result = new AcceleratorCapability
        {
            Kind = kind,
            PlatformSupported = platform,
            CompiledIn = compiled,
            DevicePresent = devicePresent,
            Device = device,
        };
        if (!platform)
            return result with { Notes = [$"{kind.Label()} is not available on {caps.Platform.Os}."] };
        if (!compiled)
        {
            notes.Add(kind == HardwareAcceleration.Qsv
                ? "This ffmpeg build has no QSV encoders (distribution ffmpeg usually lacks libvpl); VA-API covers Intel GPUs, or use jellyfin-ffmpeg."
                : $"This ffmpeg build lacks '{h264Encoder}' or the '{hwaccel}' hwaccel.");
            return result with { Notes = notes };
        }

        var deviceChecks = new Dictionary<string, CapabilityCheck>(StringComparer.Ordinal);
        if (devicePresent == false)
        {
            await CheckOtherDevicesAsync(kind, settings, devices, device, deviceChecks, ct);
            return result with { Notes = WithAlternative(kind, notes, devices, deviceChecks, device, out var missingAlternative), DeviceChecks = deviceChecks, AlternativeDevice = missingAlternative };
        }

        var init = HardwareProfiles.InitArgs(kind, settings.VaapiDevice, settings.NvencDevice);
        var h264 = await EncodeTestAsync(kind, init, "h264", settings.NvencDevice, ct);
        var hevc = caps.Encoders.Contains(HardwareProfiles.EncoderName(kind, "hevc"))
            ? await EncodeTestAsync(kind, init, "hevc", settings.NvencDevice, ct)
            : new CapabilityCheck(false, "No hardware HEVC encoder in this build.");

        var decode = new Dictionary<string, CapabilityCheck>();
        foreach (var codec in DecodeCodecs.All)
        {
            var clip = clips.FirstOrDefault(c => c.Codec == codec);
            decode[codec] = clip is null
                ? new CapabilityCheck(null, "No test clip could be generated for this codec.")
                : await DecodeTestAsync(kind, init, clip, ct);
        }

        var toneMap = await ToneMapTestAsync(kind, init, caps, clips, ct);
        if (h264.Passed == false && decode.Values.All(d => d.Passed != true))
            notes.Add(DeviceHint(kind));

        if (device is not null)
            deviceChecks[device] = h264;
        await CheckOtherDevicesAsync(kind, settings, devices, device, deviceChecks, ct);

        return result with
        {
            H264Encode = h264,
            HevcEncode = hevc,
            Decode = decode,
            ToneMapping = toneMap,
            Notes = h264.Passed == true ? notes : WithAlternative(kind, notes, devices, deviceChecks, device, out _),
            DeviceChecks = deviceChecks,
            AlternativeDevice = h264.Passed == true ? null : Alternative(devices, deviceChecks, device),
        };
    }

    /// <summary>A quick H.264 encode on every other GPU the backend could use, so a multi-GPU host shows which one works.</summary>
    private async Task CheckOtherDevicesAsync(
        HardwareAcceleration kind,
        TranscodingSettings settings,
        IReadOnlyList<GpuDevice> devices,
        string? configured,
        Dictionary<string, CapabilityCheck> checks,
        CancellationToken ct)
    {
        foreach (var candidate in CandidateDevices(kind, devices).Where(d => d.Id != configured))
        {
            var index = candidate.Index ?? settings.NvencDevice;
            var init = kind == HardwareAcceleration.Nvenc
                ? HardwareProfiles.InitArgs(kind, settings.VaapiDevice, index)
                : HardwareProfiles.InitArgs(kind, candidate.Id);
            checks[candidate.Id] = await EncodeTestAsync(kind, init, "h264", index, ct);
        }
    }

    internal static IEnumerable<GpuDevice> CandidateDevices(HardwareAcceleration kind, IReadOnlyList<GpuDevice> devices) => kind switch
    {
        HardwareAcceleration.Vaapi => devices.Where(d => d.Kind == GpuDeviceKind.Drm && !d.IsNvidiaDriver),
        HardwareAcceleration.Qsv => devices.Where(d => d.Kind == GpuDeviceKind.Drm && d.VendorId == "0x8086"),
        HardwareAcceleration.Nvenc => devices.Where(d => d.Kind == GpuDeviceKind.Cuda),
        _ => [],
    };

    private static string? Alternative(IReadOnlyList<GpuDevice> devices, IReadOnlyDictionary<string, CapabilityCheck> checks, string? configured)
        => devices.FirstOrDefault(d => d.Id != configured && checks.TryGetValue(d.Id, out var check) && check.Passed == true)?.Id;

    private static List<string> WithAlternative(
        HardwareAcceleration kind,
        List<string> notes,
        IReadOnlyList<GpuDevice> devices,
        IReadOnlyDictionary<string, CapabilityCheck> checks,
        string? configured,
        out string? alternative)
    {
        var found = Alternative(devices, checks, configured);
        alternative = found;
        if (found is not null && devices.FirstOrDefault(d => d.Id == found) is { } working)
            notes.Add($"{working.Label} passes the {kind.Label()} encode test — select it as the device in Settings.");
        return notes;
    }

    private async Task<CapabilityCheck> EncodeTestAsync(
        HardwareAcceleration kind, IReadOnlyList<string> init, string codec, int nvencDevice, CancellationToken ct)
    {
        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "level+warning" };
        args.AddRange(init);
        args.AddRange(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=1"]);
        args.AddRange(["-vf", HardwareProfiles.UploadFilter(kind), "-c:v", HardwareProfiles.EncoderName(kind, codec)]);
        args.AddRange(HardwareProfiles.EncoderDeviceArgs(kind, nvencDevice));
        args.AddRange(["-b:v", "2000k", "-f", "null", "-"]);
        return Check(await Run(options.Value.FfmpegPath, args, ct));
    }

    private async Task<CapabilityCheck> DecodeTestAsync(
        HardwareAcceleration kind, IReadOnlyList<string> init, TestClip clip, CancellationToken ct)
    {
        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "level+warning" };
        args.AddRange(init);
        args.AddRange(HardwareProfiles.DecodeArgs(kind));
        args.AddRange(["-i", clip.Path, "-vf", $"hwdownload,format={(clip.TenBit ? "p010le" : "nv12")}", "-f", "null", "-"]);
        return Check(await Run(options.Value.FfmpegPath, args, ct));
    }

    private async Task<CapabilityCheck> ToneMapTestAsync(
        HardwareAcceleration kind, IReadOnlyList<string> init, FfmpegCapabilities caps, IReadOnlyList<TestClip> clips, CancellationToken ct)
    {
        var hdr = clips.FirstOrDefault(c => c.Codec == DecodeCodecs.Hevc10);
        string? filter = kind switch
        {
            HardwareAcceleration.VideoToolbox =>
                "scale_vt=w=320:h=180:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le",
            HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv when caps.Filters.Contains("tonemap_vaapi") =>
                "scale_vaapi=w=320:h=180:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,hwdownload,format=nv12",
            _ => null,
        };
        if (filter is null)
        {
            return caps.SoftwareToneMapping
                ? new CapabilityCheck(null, "No hardware tone mapping; HDR is tone-mapped on the CPU (zscale).")
                : new CapabilityCheck(false, "Neither hardware nor software (zscale) tone mapping is available.");
        }
        if (hdr is null)
            return new CapabilityCheck(null, "No HDR test clip could be generated.");

        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "level+warning" };
        args.AddRange(init);
        args.AddRange(HardwareProfiles.DecodeArgs(kind));
        args.AddRange(["-i", hdr.Path, "-vf", filter, "-f", "null", "-"]);
        return Check(await Run(options.Value.FfmpegPath, args, ct));
    }

    private async Task<IReadOnlyList<TestClip>> GenerateClipsAsync(FfmpegCapabilities caps, string directory, CancellationToken ct)
    {
        var specs = new List<(string Codec, string File, bool TenBit, string? Encoder, string[] Args)>
        {
            (DecodeCodecs.H264, "h264.mkv", false, "libx264", ["-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-pix_fmt", "yuv420p"]),
            (DecodeCodecs.Hevc, "hevc.mkv", false, "libx265", ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"]),
            (DecodeCodecs.Hevc10, "hevc10.mkv", true, "libx265",
            [
                "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
                "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
                "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
            ]),
            (DecodeCodecs.Vp9, "vp9.webm", false, "libvpx-vp9", ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"]),
            (DecodeCodecs.Vp910, "vp910.webm", true, "libvpx-vp9",
                ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p10le", "-profile:v", "2"]),
            (DecodeCodecs.Av1, "av1.mkv", false, Av1Encoder(caps), Av1Args(Av1Encoder(caps))),
            (DecodeCodecs.Mpeg2, "mpeg2.mkv", false, "mpeg2video", ["-c:v", "mpeg2video", "-b:v", "2000k"]),
        };

        var clips = new List<TestClip>();
        foreach (var (codec, file, tenBit, encoder, codecArgs) in specs)
        {
            if (encoder is null || !caps.Encoders.Contains(encoder))
                continue;
            var path = Path.Combine(directory, file);
            var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=3" };
            args.AddRange(codecArgs);
            args.Add(path);
            var result = await Run(options.Value.FfmpegPath, args, ct);
            if (result.Succeeded && File.Exists(path))
                clips.Add(new TestClip(codec, path, tenBit));
            else
                logger.LogDebug("Could not generate {Codec} capability clip: {Error}", codec, TranscodeRedaction.Tail(result.StandardError, 2));
        }
        return clips;
    }

    private async Task<bool> DetectKeyframeSemanticsAsync(
        FfmpegCapabilities caps, IReadOnlyList<TestClip> clips, string directory, CancellationToken ct)
    {
        var fallback = caps.MajorVersion is null or >= 6;
        var clip = clips.FirstOrDefault(c => c.Codec == DecodeCodecs.H264);
        if (clip is null || !caps.FfprobeFound)
            return fallback;

        var output = Path.Combine(directory, "keyframes.mkv");
        var encode = await Run(options.Value.FfmpegPath,
        [
            "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", "1.5", "-i", clip.Path,
            "-copyts", "-start_at_zero", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-sc_threshold", "0",
            "-force_key_frames", "expr:gte(t,n_forced*1)", output,
        ], ct);
        if (!encode.Succeeded)
            return fallback;

        var probe = await runner.RunAsync(options.Value.FfprobePath,
        [
            "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", output,
        ], StepTimeout, ct);
        if (!probe.Succeeded)
            return fallback;

        var keyframes = probe.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(','))
            .Where(parts => parts.Length >= 2 && parts[1].Contains('K'))
            .Select(parts => double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var t) ? t : double.NaN)
            .Count(t => t < 2.4);
        return keyframes <= 1;
    }

    private async Task<(bool, string?)> DetectFfprobeAsync(CancellationToken ct)
    {
        try
        {
            var result = await runner.RunAsync(options.Value.FfprobePath, ["-hide_banner", "-version"], StepTimeout, ct);
            return result.Succeeded ? (true, ParseVersion(result.StandardOutput).Version) : (false, null);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or FileNotFoundException or InvalidOperationException)
        {
            return (false, null);
        }
    }

    private async Task<PlatformInfo> DetectPlatformAsync(CancellationToken ct)
    {
        var os = OperatingSystem.IsLinux() ? "Linux" : OperatingSystem.IsMacOS() ? "macOS" : OperatingSystem.IsWindows() ? "Windows" : RuntimeInformation.OSDescription;
        var container = File.Exists("/.dockerenv") || File.Exists("/run/.containerenv");
        string? cpu = null;
        try
        {
            if (OperatingSystem.IsLinux() && File.Exists("/proc/cpuinfo"))
            {
                cpu = File.ReadLines("/proc/cpuinfo")
                    .FirstOrDefault(l => l.StartsWith("model name", StringComparison.OrdinalIgnoreCase))
                    ?.Split(':', 2)[1].Trim();
            }
            else if (OperatingSystem.IsMacOS())
            {
                var result = await runner.RunAsync("sysctl", ["-n", "machdep.cpu.brand_string"], TimeSpan.FromSeconds(3), ct);
                cpu = result.Succeeded ? result.StandardOutput.Trim() : null;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
        }
        return new PlatformInfo(os, RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(), container, cpu, Environment.ProcessorCount);
    }

    private static (bool?, string?) DeviceState(
        HardwareAcceleration kind, TranscodingSettings settings, IReadOnlyList<GpuDevice> devices, List<string> notes)
    {
        switch (kind)
        {
            case HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv:
            {
                var nodes = devices.Where(d => d.Kind == GpuDeviceKind.Drm).ToList();
                var selected = nodes.FirstOrDefault(d => d.Id == settings.VaapiDevice);
                var present = selected is not null || File.Exists(settings.VaapiDevice);
                if (!present)
                {
                    notes.Add(nodes.Count == 0
                        ? "No /dev/dri devices are visible. In Docker add `devices: [\"/dev/dri:/dev/dri\"]` and `group_add` the host's render group."
                        : $"{settings.VaapiDevice} does not exist. Available: {string.Join("; ", nodes.Select(n => n.Label))}.");
                }
                else if (selected?.IsNvidiaDriver == true)
                {
                    notes.Add($"{selected.Label} belongs to the NVIDIA driver, which has no VA-API support. Use NVENC for this GPU, or pick another render node.");
                }
                return (present, settings.VaapiDevice);
            }
            case HardwareAcceleration.Nvenc:
            {
                var gpus = devices.Where(d => d.Kind == GpuDeviceKind.Cuda).ToList();
                var id = GpuDevice.CudaId(settings.NvencDevice);
                if (gpus.Count == 0)
                {
                    notes.Add("No NVIDIA GPU is visible. In Docker install the NVIDIA Container Toolkit and request the GPU (`gpus: all`).");
                    return (false, id);
                }
                var present = gpus.Any(g => g.Index == settings.NvencDevice);
                if (!present)
                    notes.Add($"GPU {settings.NvencDevice} does not exist. Available: {string.Join("; ", gpus.Select(g => g.Label))}.");
                return (present, id);
            }
            default:
                return (null, null);
        }
    }

    private static string DeviceHint(HardwareAcceleration kind) => kind switch
    {
        HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv =>
            "Every test failed. Check that the process can open the render node (group `render`/`video`) and that a VA driver (intel-media-va-driver or mesa-va-drivers) is installed.",
        HardwareAcceleration.Nvenc =>
            "Every test failed. Check the NVIDIA driver version and that libcuda/libnvidia-encode are mounted into the container.",
        _ => "Every test failed on this device.",
    };

    private static string? Av1Encoder(FfmpegCapabilities caps)
        => new[] { "libsvtav1", "libaom-av1", "librav1e" }.FirstOrDefault(caps.Encoders.Contains);

    private static string[] Av1Args(string? encoder) => encoder switch
    {
        "libsvtav1" => ["-c:v", "libsvtav1", "-preset", "12", "-pix_fmt", "yuv420p"],
        "libaom-av1" => ["-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "1", "-usage", "realtime", "-pix_fmt", "yuv420p"],
        "librav1e" => ["-c:v", "librav1e", "-speed", "10", "-pix_fmt", "yuv420p"],
        _ => [],
    };

    private Task<ProcessResult> Run(string file, IReadOnlyList<string> args, CancellationToken ct)
        => runner.RunAsync(file, args, StepTimeout, ct);

    private static CapabilityCheck Check(ProcessResult result)
    {
        if (result.Succeeded && !HasHardwareFailure(result.StandardError))
            return new CapabilityCheck(true, $"{result.Elapsed.TotalMilliseconds:0} ms");
        var detail = result.TimedOut ? "Timed out." : TranscodeRedaction.Summarize(result.StandardError);
        return new CapabilityCheck(false, string.IsNullOrWhiteSpace(detail) ? $"ffmpeg exited with {result.ExitCode}." : detail);
    }

    internal static bool HasHardwareFailure(string stderr)
        => stderr.Contains("Failed setup for format", StringComparison.Ordinal)
           || stderr.Contains("hwaccel initialisation returned error", StringComparison.Ordinal);

    internal static (string? Version, int? Major) ParseVersion(string output)
    {
        var match = VersionLine().Match(output);
        if (!match.Success)
            return (null, null);
        var version = match.Groups[1].Value;
        var numeric = MajorVersion().Match(version);
        return (version, numeric.Success ? int.Parse(numeric.Groups[1].Value, CultureInfo.InvariantCulture) : null);
    }

    internal static IReadOnlySet<string> ParseCodecList(string output)
        => output.Split('\n')
            .Select(line => CodecLine().Match(line))
            .Where(m => m.Success && m.Groups[1].Value != "=")
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);

    internal static IReadOnlySet<string> ParseFilters(string output)
        => output.Split('\n')
            .Select(line => FilterLine().Match(line))
            .Where(m => m.Success)
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);

    internal static IReadOnlySet<string> ParseHwAccels(string output)
        => output.Split('\n')
            .Select(l => l.Trim())
            .SkipWhile(l => !l.StartsWith("Hardware acceleration methods", StringComparison.OrdinalIgnoreCase))
            .Skip(1)
            .Where(l => l.Length > 0 && !l.Contains(' '))
            .ToHashSet(StringComparer.Ordinal);

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    [GeneratedRegex(@"(?:ffmpeg|ffprobe) version (\S+)", RegexOptions.CultureInvariant)]
    private static partial Regex VersionLine();

    [GeneratedRegex(@"^n?(\d+)\.\d+", RegexOptions.CultureInvariant)]
    private static partial Regex MajorVersion();

    [GeneratedRegex(@"^\s[VASDF\.][F\.][S\.][X\.][B\.][D\.]\s+(\S+)", RegexOptions.CultureInvariant)]
    private static partial Regex CodecLine();

    [GeneratedRegex(@"^\s[T\.][S\.][C\.]?\s+(\S+)\s+\S*->\S*", RegexOptions.CultureInvariant)]
    private static partial Regex FilterLine();
}
