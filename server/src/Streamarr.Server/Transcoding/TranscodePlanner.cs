using System.Globalization;

namespace Streamarr.Server.Transcoding;

/// <summary>What the requesting player can decode natively; drives direct-play assessment and output codec choice.</summary>
public sealed record ClientProfile
{
    public IReadOnlyList<string> VideoCodecs { get; init; } = ["h264"];
    public IReadOnlyList<string> AudioCodecs { get; init; } = ["aac", "mp3"];
    public IReadOnlyList<string> Containers { get; init; } = ["mp4"];
    public int MaxAudioChannels { get; init; } = 2;
    public bool SupportsHdr { get; init; }
    public bool Supports10Bit { get; init; }

    public static ClientProfile Default { get; } = new();
}

public sealed record TranscodeLimits(int? MaxHeight = null, int? MaxBitrateKbps = null, int? AudioStreamIndex = null);

public enum ToneMapMode
{
    NotNeeded,
    Hardware,
    Software,
    Disabled,
    Unavailable,
}

public sealed record VideoTarget(
    string Codec,
    int Width,
    int Height,
    int BitrateKbps,
    double FrameRate,
    string Level,
    string CodecsTag);

public sealed record AudioTarget(int SourceIndex, string SourceCodec, bool Copy, int Channels, int BitrateKbps, int? SampleRate)
{
    public const string CodecsTag = "mp4a.40.2";
}

public sealed record TranscodePlan
{
    public required SourceVideoStream SourceVideo { get; init; }
    public required VideoTarget Video { get; init; }
    public AudioTarget? Audio { get; init; }
    public bool DirectPlayPossible { get; init; }
    public IReadOnlyList<string> DirectPlayBlockers { get; init; } = [];
    public HardwareAcceleration Acceleration { get; init; }
    public bool HardwareDecode { get; init; }
    public string HardwareDecodeReason { get; init; } = string.Empty;
    public bool HardwareEncode { get; init; }
    public string HardwareEncodeReason { get; init; } = string.Empty;
    public required string Encoder { get; init; }
    public ToneMapMode ToneMap { get; init; }
    public bool Deinterlace { get; init; }
    public IReadOnlyList<string> Warnings { get; init; } = [];
    public double DurationSeconds { get; init; }

    public bool Scales => Video.Width != SourceVideo.Width || Video.Height != SourceVideo.Height;

    public int BandwidthBitsPerSecond => (Video.BitrateKbps + (Audio?.BitrateKbps ?? 0)) * 1000;

    public string CodecsAttribute => Audio is null ? Video.CodecsTag : $"{Video.CodecsTag},{AudioTarget.CodecsTag}";
}

public sealed class TranscodePlanningException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>Pure decision engine: source + client + policy + detected hardware → one concrete transcode plan with reasons.</summary>
public static class TranscodePlanner
{
    private const int MinimumVideoBitrateKbps = 400;

    public static TranscodePlan Plan(
        SourceMediaInfo media,
        ClientProfile client,
        TranscodeLimits limits,
        TranscodingSettings settings,
        FfmpegCapabilities capabilities)
    {
        var video = media.Video
                    ?? throw new TranscodePlanningException("no_video_stream", "The source has no video stream to transcode.");
        if (video.Width <= 0 || video.Height <= 0)
            throw new TranscodePlanningException("unknown_dimensions", "The source video dimensions could not be determined.");
        if (media.DurationSeconds <= 0)
            throw new TranscodePlanningException("unknown_duration", "The source duration could not be determined; seekable HLS needs it.");

        var warnings = new List<string>();
        var audio = SelectAudio(media, limits.AudioStreamIndex);
        var maxHeight = Math.Min(settings.MaxHeight, limits.MaxHeight ?? int.MaxValue);
        var maxBitrate = Math.Min(settings.MaxBitrateKbps, limits.MaxBitrateKbps ?? int.MaxValue);

        var blockers = DirectPlayBlockers(media, video, audio, client, maxHeight, maxBitrate);

        var outputCodec = settings.AllowHevcOutput && Contains(client.VideoCodecs, "hevc") ? "hevc" : "h264";
        var (width, height) = FitWithin(video.Width, video.Height, maxHeight);
        var frameRate = video.FrameRate is > 0 and <= 120 ? video.FrameRate.Value : 25;
        var audioTarget = audio is null ? null : PlanAudio(audio, client, settings);
        var bitrate = TargetBitrate(media, video, width, height, maxBitrate - (audioTarget?.BitrateKbps ?? 0), outputCodec);
        var level = outputCodec == "hevc" ? HevcLevel(width, height, frameRate) : H264Level(width, height, frameRate);
        var codecsTag = outputCodec == "hevc" ? HevcCodecsTag(level) : H264CodecsTag(level);

        var accel = settings.Acceleration;
        var accelCap = accel == HardwareAcceleration.None ? null : capabilities.For(accel);
        if (accel != HardwareAcceleration.None && accelCap is not { CompiledIn: true, PlatformSupported: true })
        {
            warnings.Add($"{accel.Label()} is configured but not available in this ffmpeg build or platform; using software.");
            accel = HardwareAcceleration.None;
            accelCap = null;
        }

        var deinterlace = video.Interlaced;
        var (hwDecode, hwDecodeReason) = DecideHardwareDecode(video, settings, accel, accelCap, deinterlace);
        var (hwEncode, hwEncodeReason, encoder) = DecideEncoder(outputCodec, settings, accel, accelCap, capabilities, warnings);
        if (!hwEncode && encoder == "libx265" && !capabilities.Encoders.Contains("libx265"))
        {
            outputCodec = "h264";
            encoder = "libx264";
            level = H264Level(width, height, frameRate);
            codecsTag = H264CodecsTag(level);
        }

        var toneMap = DecideToneMap(video, settings, accel, hwDecode, capabilities, warnings);
        if (video.Hdr == HdrFormat.DolbyVision && toneMap is ToneMapMode.Software or ToneMapMode.Hardware)
            warnings.Add("Dolby Vision without an HDR10 base layer may tone-map with incorrect colors.");

        return new TranscodePlan
        {
            SourceVideo = video,
            Video = new VideoTarget(outputCodec, width, height, bitrate, frameRate, level, codecsTag),
            Audio = audioTarget,
            DirectPlayPossible = blockers.Count == 0,
            DirectPlayBlockers = blockers,
            Acceleration = accel,
            HardwareDecode = hwDecode,
            HardwareDecodeReason = hwDecodeReason,
            HardwareEncode = hwEncode,
            HardwareEncodeReason = hwEncodeReason,
            Encoder = encoder,
            ToneMap = toneMap,
            Deinterlace = deinterlace,
            Warnings = warnings,
            DurationSeconds = media.DurationSeconds,
        };
    }

    internal static SourceAudioStream? SelectAudio(SourceMediaInfo media, int? requestedIndex)
    {
        if (requestedIndex is { } index)
        {
            return media.Audio.FirstOrDefault(a => a.Index == index)
                   ?? throw new TranscodePlanningException("unknown_audio_stream", $"Audio stream {index} does not exist in the source.");
        }
        return media.Audio.FirstOrDefault(a => a.IsDefault) ?? media.Audio.FirstOrDefault();
    }

    private static List<string> DirectPlayBlockers(
        SourceMediaInfo media, SourceVideoStream video, SourceAudioStream? audio, ClientProfile client, int maxHeight, int maxBitrate)
    {
        var blockers = new List<string>();
        var container = ContainerFamily(media.Container);
        if (!Contains(client.Containers, container))
            blockers.Add($"Container '{container}' is not supported by the player.");
        if (!Contains(client.VideoCodecs, video.Codec))
            blockers.Add($"Video codec '{video.Codec}' is not supported by the player.");
        if (video.BitDepth > 8 && !client.Supports10Bit)
            blockers.Add($"{video.BitDepth}-bit video is not supported by the player.");
        if (video.Hdr != HdrFormat.None && !client.SupportsHdr)
            blockers.Add($"{video.Hdr} HDR output is not supported by the player.");
        if (video.Interlaced)
            blockers.Add("Interlaced video needs deinterlacing.");
        if (audio is not null && !Contains(client.AudioCodecs, audio.Codec))
            blockers.Add($"Audio codec '{audio.Codec}' is not supported by the player.");
        if (video.Height > maxHeight)
            blockers.Add($"Resolution {video.Height}p exceeds the {maxHeight}p limit.");
        if (media.BitRate is { } bps && bps / 1000 > maxBitrate)
            blockers.Add($"Bitrate {bps / 1000} kbps exceeds the {maxBitrate} kbps limit.");
        return blockers;
    }

    internal static string ContainerFamily(string? formatName)
    {
        var names = (formatName ?? string.Empty).Split(',');
        if (names.Contains("webm") && names.Contains("matroska"))
            return "mkv";
        if (names.Contains("mp4") || names.Contains("mov"))
            return "mp4";
        if (names.Contains("mpegts"))
            return "ts";
        return names.FirstOrDefault(n => n.Length > 0) ?? "unknown";
    }

    internal static (int Width, int Height) FitWithin(int width, int height, int maxHeight)
    {
        var boxHeight = maxHeight;
        var boxWidth = (int)Math.Ceiling(maxHeight * 16d / 9d - 1e-9);
        var factor = Math.Min(1d, Math.Min(boxWidth / (double)width, boxHeight / (double)height));
        var w = Math.Max(2, (int)Math.Round(width * factor / 2d) * 2);
        var h = Math.Max(2, (int)Math.Round(height * factor / 2d) * 2);
        return (w, h);
    }

    internal static int TargetBitrate(SourceMediaInfo media, SourceVideoStream video, int width, int height, int videoBudgetKbps, string outputCodec)
    {
        var target = videoBudgetKbps;
        if (media.EstimatedVideoBitRate is { } sourceBps && sourceBps > 0)
        {
            var efficiency = video.Codec switch
            {
                "hevc" or "vp9" => 1.5,
                "av1" => 1.8,
                "mpeg2video" or "mpeg4" or "vc1" => 0.8,
                _ => 1.0,
            };
            if (outputCodec == "hevc")
                efficiency /= 1.5;
            var area = (double)width * height / ((double)video.Width * video.Height);
            var equivalent = sourceBps / 1000d * efficiency * Math.Pow(area, 0.75) * 1.25;
            target = (int)Math.Min(target, Math.Ceiling(equivalent));
        }
        return Math.Max(MinimumVideoBitrateKbps, target);
    }

    internal static string H264Level(int width, int height, double fps)
    {
        var mbs = (int)(Math.Ceiling(width / 16d) * Math.Ceiling(height / 16d));
        var mbps = mbs * fps;
        return (mbs, mbps) switch
        {
            _ when mbs <= 8192 && mbps <= 245_760 => "4.1",
            _ when mbs <= 8704 && mbps <= 522_240 => "4.2",
            _ when mbs <= 22_080 && mbps <= 589_824 => "5.0",
            _ when mbs <= 36_864 && mbps <= 983_040 => "5.1",
            _ => "5.2",
        };
    }

    internal static string HevcLevel(int width, int height, double fps)
    {
        var samples = (double)width * height;
        var rate = samples * fps;
        return (samples, rate) switch
        {
            _ when samples <= 2_228_224 && rate <= 66_846_720 => "4.0",
            _ when samples <= 2_228_224 && rate <= 133_693_440 => "4.1",
            _ when samples <= 8_912_896 && rate <= 267_386_880 => "5.0",
            _ when samples <= 8_912_896 && rate <= 534_773_760 => "5.1",
            _ => "5.2",
        };
    }

    internal static string H264CodecsTag(string level)
        => "avc1.6400" + ((int)Math.Round(double.Parse(level, CultureInfo.InvariantCulture) * 10)).ToString("x2", CultureInfo.InvariantCulture);

    internal static string HevcCodecsTag(string level)
        => $"hvc1.1.6.L{(int)Math.Round(double.Parse(level, CultureInfo.InvariantCulture) * 30)}.B0";

    private static AudioTarget PlanAudio(SourceAudioStream audio, ClientProfile client, TranscodingSettings settings)
    {
        var surround = settings.AllowSurroundAudio && client.MaxAudioChannels >= 6 && audio.Channels >= 6;
        var channels = surround ? 6 : Math.Clamp(audio.Channels, 1, 2);
        var copy = audio.Codec == "aac" && audio.Profile is null or "LC" && audio.Channels == channels && Contains(client.AudioCodecs, "aac");
        var bitrate = channels switch
        {
            1 => Math.Min(128, settings.AudioBitrateKbps),
            2 => settings.AudioBitrateKbps,
            _ => Math.Min(640, settings.AudioBitrateKbps * 3),
        };
        int? sampleRate = audio.SampleRate is > 48_000 or < 16_000 ? 48_000 : null;
        return new AudioTarget(audio.Index, audio.Codec, copy, channels, bitrate, sampleRate);
    }

    private static (bool, string) DecideHardwareDecode(
        SourceVideoStream video, TranscodingSettings settings, HardwareAcceleration accel, AcceleratorCapability? cap, bool deinterlace)
    {
        if (accel == HardwareAcceleration.None)
            return (false, "Software transcoding is configured.");
        if (!settings.HardwareDecoding)
            return (false, "Hardware decoding is disabled in the settings.");
        if (deinterlace)
            return (false, "Interlaced sources are deinterlaced on the CPU.");
        var key = DecodeCodecs.KeyFor(video.Codec, video.BitDepth);
        if (key is null)
            return (false, $"No hardware decoder path for {video.BitDepth}-bit {video.Codec}.");
        var allowed = settings.HardwareDecodingCodecs ?? cap?.ValidatedDecodeCodecs ?? [];
        if (!allowed.Contains(key))
        {
            return settings.HardwareDecodingCodecs is null
                ? (false, $"The capability test did not validate hardware decoding of '{key}' on this device.")
                : (false, $"Hardware decoding of '{key}' is not enabled in the settings.");
        }
        return (true, $"{accel.Label()} decodes '{key}'.");
    }

    private static (bool, string, string) DecideEncoder(
        string outputCodec,
        TranscodingSettings settings,
        HardwareAcceleration accel,
        AcceleratorCapability? cap,
        FfmpegCapabilities capabilities,
        List<string> warnings)
    {
        var software = outputCodec == "hevc" ? "libx265" : "libx264";
        if (accel == HardwareAcceleration.None)
            return (false, "Software transcoding is configured.", software);
        if (!settings.HardwareEncoding)
            return (false, "Hardware encoding is disabled in the settings.", software);

        var hardware = HardwareProfiles.EncoderName(accel, outputCodec);
        if (!capabilities.Encoders.Contains(hardware))
            return (false, $"ffmpeg has no '{hardware}' encoder.", software);

        var check = outputCodec == "hevc" ? cap?.HevcEncode : cap?.H264Encode;
        if (check?.Passed == false)
        {
            warnings.Add($"The '{hardware}' self-test failed; falling back to software encoding.");
            return (false, $"The '{hardware}' self-test failed: {check.Detail}", software);
        }
        return (true, $"{accel.Label()} encodes with '{hardware}'.", hardware);
    }

    private static ToneMapMode DecideToneMap(
        SourceVideoStream video,
        TranscodingSettings settings,
        HardwareAcceleration accel,
        bool hwDecode,
        FfmpegCapabilities capabilities,
        List<string> warnings)
    {
        if (video.Hdr == HdrFormat.None)
            return ToneMapMode.NotNeeded;
        if (!settings.ToneMapping)
        {
            warnings.Add("HDR source without tone mapping: colors will look washed out on SDR screens.");
            return ToneMapMode.Disabled;
        }
        if (hwDecode && accel == HardwareAcceleration.VideoToolbox)
            return ToneMapMode.Hardware;
        if (hwDecode && accel is HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv && capabilities.Filters.Contains("tonemap_vaapi")
            && video.Hdr != HdrFormat.Hlg)
        {
            return ToneMapMode.Hardware;
        }
        if (capabilities.SoftwareToneMapping)
            return ToneMapMode.Software;

        warnings.Add("This ffmpeg build has no tone-mapping filter (zscale/tonemap); HDR colors will look washed out.");
        return ToneMapMode.Unavailable;
    }

    private static bool Contains(IReadOnlyList<string> values, string value)
        => values.Any(v => string.Equals(v, value, StringComparison.OrdinalIgnoreCase));
}
