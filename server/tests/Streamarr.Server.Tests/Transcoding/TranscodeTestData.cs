using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Tests.Transcoding;

internal static class TranscodeTestData
{
    public static SourceMediaInfo Media(
        string codec = "h264",
        int width = 1920,
        int height = 1080,
        int bitDepth = 8,
        HdrFormat hdr = HdrFormat.None,
        bool interlaced = false,
        string container = "matroska,webm",
        string audioCodec = "ac3",
        int channels = 6,
        double duration = 600,
        long? bitRate = 6_000_000,
        double fps = 24000d / 1001,
        int? dvProfile = null,
        int? dvCompatibility = null,
        string? colorTransfer = null,
        params SourceSubtitleStream[] subtitles) => new()
    {
        DurationSeconds = duration,
        BitRate = bitRate,
        Container = container,
        Video = new SourceVideoStream
        {
            Index = 0,
            Codec = codec,
            Width = width,
            Height = height,
            BitDepth = bitDepth,
            PixelFormat = bitDepth > 8 ? "yuv420p10le" : "yuv420p",
            FrameRate = fps,
            Hdr = hdr,
            Interlaced = interlaced,
            DolbyVisionProfile = dvProfile,
            DolbyVisionCompatibility = dvCompatibility,
            ColorTransfer = colorTransfer,
        },
        Audio =
        [
            new SourceAudioStream { Index = 1, Codec = audioCodec, Channels = channels, Profile = audioCodec == "aac" ? "LC" : null, SampleRate = 48_000 },
        ],
        Subtitles = subtitles,
    };

    public static SourceSubtitleStream Subtitle(int index, string codec, string? language = "eng", bool forced = false, string? title = null)
        => new() { Index = index, Codec = codec, Language = language, IsForced = forced, Title = title };

    public static TranscodePlan Decide(
        SourceMediaInfo media,
        ClientProfile client,
        ModePreference preference = ModePreference.Auto,
        bool allowDirect = true,
        TranscodeLimits? limits = null,
        TranscodingSettings? settings = null,
        PlanReason? remuxUnavailable = null)
        => TranscodePlanner.Decide(
            media, client, limits ?? new TranscodeLimits(), settings ?? new TranscodingSettings(),
            Capabilities() with { Encoders = new HashSet<string>(Capabilities().Encoders) { "ac3", "eac3" } },
            preference, allowDirect, remuxUnavailable);

    public static FfmpegCapabilities Capabilities(
        params AcceleratorCapability[] accelerators) => new()
    {
        FfmpegFound = true,
        FfprobeFound = true,
        Version = "7.1",
        MajorVersion = 7,
        Encoders = new HashSet<string>
        {
            "libx264", "libx265", "aac",
            "h264_videotoolbox", "hevc_videotoolbox", "h264_vaapi", "hevc_vaapi", "h264_qsv", "hevc_qsv", "h264_nvenc", "hevc_nvenc",
        },
        Filters = new HashSet<string> { "scale", "zscale", "tonemap", "bwdif", "scale_vt", "scale_vaapi", "tonemap_vaapi", "scale_cuda" },
        Accelerators = accelerators,
    };

    public static AcceleratorCapability Accelerator(
        HardwareAcceleration kind,
        bool h264Encode = true,
        params string[] decode) => new()
    {
        Kind = kind,
        PlatformSupported = true,
        CompiledIn = true,
        DevicePresent = true,
        H264Encode = new CapabilityCheck(h264Encode, h264Encode ? "120 ms" : "Device creation failed"),
        HevcEncode = new CapabilityCheck(true),
        Decode = DecodeCodecs.All.ToDictionary(c => c, c => new CapabilityCheck(decode.Contains(c))),
    };

    public static TranscodePlan Plan(
        SourceMediaInfo? media = null,
        TranscodingSettings? settings = null,
        FfmpegCapabilities? capabilities = null,
        ClientProfile? client = null,
        TranscodeLimits? limits = null)
        => TranscodePlanner.Plan(
            media ?? Media(),
            client ?? ClientProfile.Default,
            limits ?? new TranscodeLimits(),
            settings ?? new TranscodingSettings(),
            capabilities ?? Capabilities());

    public static FfmpegJobSpec Spec(
        TranscodePlan plan,
        TranscodingSettings? settings = null,
        FfmpegCapabilities? capabilities = null,
        int startSegment = 0,
        bool network = false) => new()
    {
        Plan = plan,
        Source = network
            ? new TranscodeSource(TranscodeSource.StreamKind, "http://127.0.0.1:8080/api/v1/stream/abc123", true, "Movie")
            : new TranscodeSource(TranscodeSource.SampleKind, "/samples/movie.mkv", false, "Movie"),
        Settings = settings ?? new TranscodingSettings(),
        Capabilities = capabilities ?? Capabilities(),
        OutputDirectory = "/work/session",
        JobTag = "1",
        SegmentLength = 4,
        StartSegment = startSegment,
    };
}
