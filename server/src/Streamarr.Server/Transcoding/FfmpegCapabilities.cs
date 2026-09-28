namespace Streamarr.Server.Transcoding;

public sealed record CapabilityCheck(bool? Passed, string? Detail = null)
{
    public static readonly CapabilityCheck NotRun = new((bool?)null);
}

public sealed record AcceleratorCapability
{
    public required HardwareAcceleration Kind { get; init; }
    public bool PlatformSupported { get; init; }
    public bool CompiledIn { get; init; }
    public bool? DevicePresent { get; init; }
    public string? Device { get; init; }
    public CapabilityCheck H264Encode { get; init; } = CapabilityCheck.NotRun;
    public CapabilityCheck HevcEncode { get; init; } = CapabilityCheck.NotRun;
    public IReadOnlyDictionary<string, CapabilityCheck> Decode { get; init; } = new Dictionary<string, CapabilityCheck>();
    public CapabilityCheck ToneMapping { get; init; } = CapabilityCheck.NotRun;
    public IReadOnlyList<string> Notes { get; init; } = [];

    /// <summary>Quick H.264 encode result per device id (the configured device and every other candidate GPU).</summary>
    public IReadOnlyDictionary<string, CapabilityCheck> DeviceChecks { get; init; } = new Dictionary<string, CapabilityCheck>();

    /// <summary>Another device that passed when the configured one failed or is missing.</summary>
    public string? AlternativeDevice { get; init; }

    public bool Usable => H264Encode.Passed == true || Decode.Values.Any(d => d.Passed == true);

    public IReadOnlyList<string> ValidatedDecodeCodecs
        => Decode.Where(d => d.Value.Passed == true).Select(d => d.Key).ToList();
}

public sealed record PlatformInfo(string Os, string Architecture, bool InContainer, string? CpuModel, int LogicalCores);

public sealed record FfmpegCapabilities
{
    public const int MinimumMajorVersion = 5;

    public bool FfmpegFound { get; init; }
    public string FfmpegPath { get; init; } = "ffmpeg";
    public string? Version { get; init; }
    public int? MajorVersion { get; init; }
    public bool FfprobeFound { get; init; }
    public string? FfprobeVersion { get; init; }
    public string? Error { get; init; }
    public IReadOnlySet<string> Encoders { get; init; } = new HashSet<string>();
    public IReadOnlySet<string> Decoders { get; init; } = new HashSet<string>();
    public IReadOnlySet<string> Filters { get; init; } = new HashSet<string>();
    public IReadOnlySet<string> HwAccels { get; init; } = new HashSet<string>();

    /// <summary>Whether <c>t</c> in <c>-force_key_frames expr:</c> counts from the first encoded frame (ffmpeg ≥ 6) rather than the absolute timestamp.</summary>
    public bool RelativeKeyframeExpressions { get; init; } = true;

    public IReadOnlyList<AcceleratorCapability> Accelerators { get; init; } = [];
    public IReadOnlyList<GpuDevice> Devices { get; init; } = [];
    public PlatformInfo Platform { get; init; } = new("unknown", "unknown", false, null, Environment.ProcessorCount);
    public DateTimeOffset DetectedAt { get; init; }
    public TimeSpan Duration { get; init; }

    public bool MeetsMinimumVersion => MajorVersion is null || MajorVersion >= MinimumMajorVersion;
    public bool Usable => FfmpegFound && FfprobeFound && MeetsMinimumVersion && Encoders.Contains("libx264") && Encoders.Contains("aac");
    public bool SoftwareToneMapping => Filters.Contains("zscale") && Filters.Contains("tonemap");

    public AcceleratorCapability? For(HardwareAcceleration kind) => Accelerators.FirstOrDefault(a => a.Kind == kind);

    public HardwareAcceleration Recommended
        => new[] { HardwareAcceleration.Nvenc, HardwareAcceleration.Qsv, HardwareAcceleration.Vaapi, HardwareAcceleration.VideoToolbox }
            .FirstOrDefault(k => For(k)?.H264Encode.Passed == true, HardwareAcceleration.None);

    public static FfmpegCapabilities Missing(string path, string error) => new()
    {
        FfmpegFound = false,
        FfmpegPath = path,
        Error = error,
        DetectedAt = DateTimeOffset.UtcNow,
    };
}
