using System.Text.RegularExpressions;

namespace Streamarr.Server.Transcoding;

public enum HardwareAcceleration
{
    None,
    VideoToolbox,
    Vaapi,
    Qsv,
    Nvenc,
}

public static class HardwareAccelerationNames
{
    public static string ToApi(this HardwareAcceleration value) => value switch
    {
        HardwareAcceleration.VideoToolbox => "videotoolbox",
        HardwareAcceleration.Vaapi => "vaapi",
        HardwareAcceleration.Qsv => "qsv",
        HardwareAcceleration.Nvenc => "nvenc",
        _ => "none",
    };

    public static bool TryParse(string? value, out HardwareAcceleration result)
    {
        result = (value ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "none" or "software" => HardwareAcceleration.None,
            "videotoolbox" => HardwareAcceleration.VideoToolbox,
            "vaapi" => HardwareAcceleration.Vaapi,
            "qsv" => HardwareAcceleration.Qsv,
            "nvenc" or "cuda" => HardwareAcceleration.Nvenc,
            _ => (HardwareAcceleration)(-1),
        };
        return Enum.IsDefined(result);
    }

    public static string Label(this HardwareAcceleration value) => value switch
    {
        HardwareAcceleration.VideoToolbox => "Apple VideoToolbox",
        HardwareAcceleration.Vaapi => "VA-API (Intel / AMD)",
        HardwareAcceleration.Qsv => "Intel Quick Sync (QSV)",
        HardwareAcceleration.Nvenc => "NVIDIA NVENC / NVDEC",
        _ => "Software (CPU)",
    };
}

/// <summary>Decode codec keys; 10-bit variants are separate because GPU support differs.</summary>
public static class DecodeCodecs
{
    public const string H264 = "h264";
    public const string Hevc = "hevc";
    public const string Hevc10 = "hevc10";
    public const string Vp9 = "vp9";
    public const string Vp910 = "vp910";
    public const string Av1 = "av1";
    public const string Mpeg2 = "mpeg2video";
    public const string Vc1 = "vc1";

    public static readonly IReadOnlyList<string> All = [H264, Hevc, Hevc10, Vp9, Vp910, Av1, Mpeg2, Vc1];

    public static string? KeyFor(string? codec, int bitDepth) => codec switch
    {
        "h264" => bitDepth > 8 ? null : H264,
        "hevc" => bitDepth > 8 ? Hevc10 : Hevc,
        "vp9" => bitDepth > 8 ? Vp910 : Vp9,
        "av1" => Av1,
        "mpeg2video" => Mpeg2,
        "vc1" => Vc1,
        _ => null,
    };
}

/// <summary>Operator-editable transcoding policy persisted in SQLite.</summary>
public sealed record TranscodingSettings
{
    public const int MinSegmentLength = 2;
    public const int MaxSegmentLength = 10;

    public static readonly IReadOnlyList<string> SoftwarePresets =
        ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"];

    public bool Enabled { get; init; } = true;
    public HardwareAcceleration Acceleration { get; init; } = HardwareAcceleration.None;
    public string VaapiDevice { get; init; } = "/dev/dri/renderD128";

    /// <summary>CUDA index of the NVIDIA GPU for NVENC/NVDEC, in PCI bus order (as numbered by nvidia-smi).</summary>
    public int NvencDevice { get; init; }
    public bool HardwareDecoding { get; init; } = true;

    /// <summary>Null means "use every codec the capability probe validated on this machine".</summary>
    public IReadOnlyList<string>? HardwareDecodingCodecs { get; init; }

    public bool HardwareEncoding { get; init; } = true;
    public bool ToneMapping { get; init; } = true;
    public bool AllowHevcOutput { get; init; }
    public string EncoderPreset { get; init; } = "veryfast";
    public int Crf { get; init; } = 23;
    public int MaxBitrateKbps { get; init; } = 20_000;
    public int MaxHeight { get; init; } = 2160;
    public int AudioBitrateKbps { get; init; } = 192;
    public bool AllowSurroundAudio { get; init; }
    public int SegmentLengthSeconds { get; init; } = 3;
    public bool ThrottleEnabled { get; init; } = true;
    public int ThrottleBufferSeconds { get; init; } = 120;
    public int MaxConcurrentTranscodes { get; init; } = 2;
    public int JobIdleTimeoutSeconds { get; init; } = 60;
    public int SessionIdleTimeoutSeconds { get; init; } = 1_800;
    public int SegmentRetentionSeconds { get; init; } = 900;
    public int Threads { get; init; }

    private static readonly Regex VaapiDevicePattern = new("^/dev/dri/(renderD|card)[0-9]{1,4}$", RegexOptions.CultureInvariant);

    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        if (!Enum.IsDefined(Acceleration))
            errors.Add("'acceleration' is not a supported value.");
        if (!VaapiDevicePattern.IsMatch(VaapiDevice ?? string.Empty))
            errors.Add("'vaapiDevice' must be a DRM node such as /dev/dri/renderD128.");
        if (HardwareDecodingCodecs is { } codecs && codecs.Any(c => !DecodeCodecs.All.Contains(c)))
            errors.Add($"'hardwareDecodingCodecs' may only contain: {string.Join(", ", DecodeCodecs.All)}.");
        if (!SoftwarePresets.Contains(EncoderPreset))
            errors.Add($"'encoderPreset' must be one of: {string.Join(", ", SoftwarePresets)}.");
        Range(errors, NvencDevice, 0, 15, "nvencDevice");
        Range(errors, Crf, 12, 40, "crf");
        Range(errors, MaxBitrateKbps, 500, 200_000, "maxBitrateKbps");
        Range(errors, MaxHeight, 240, 4320, "maxHeight");
        Range(errors, AudioBitrateKbps, 64, 640, "audioBitrateKbps");
        Range(errors, SegmentLengthSeconds, MinSegmentLength, MaxSegmentLength, "segmentLengthSeconds");
        Range(errors, ThrottleBufferSeconds, 30, 3_600, "throttleBufferSeconds");
        Range(errors, MaxConcurrentTranscodes, 1, 16, "maxConcurrentTranscodes");
        Range(errors, JobIdleTimeoutSeconds, 10, 3_600, "jobIdleTimeoutSeconds");
        Range(errors, SessionIdleTimeoutSeconds, 60, 86_400, "sessionIdleTimeoutSeconds");
        Range(errors, SegmentRetentionSeconds, 60, 86_400, "segmentRetentionSeconds");
        Range(errors, Threads, 0, 64, "threads");
        return errors;
    }

    private static void Range(List<string> errors, int value, int min, int max, string name)
    {
        if (value < min || value > max)
            errors.Add($"'{name}' must be between {min} and {max}.");
    }
}
