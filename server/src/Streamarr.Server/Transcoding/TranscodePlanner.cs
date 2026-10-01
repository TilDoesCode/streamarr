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

    /// <summary>HDR formats the display path renders (hdr10, hlg, dolbyvision); null falls back to <see cref="SupportsHdr"/>.</summary>
    public IReadOnlyList<string>? HdrFormats { get; init; }

    /// <summary>Subtitle formats the player renders from the original file (srt, ass, webvtt, pgs, …); null means "not declared".</summary>
    public IReadOnlyList<string>? SubtitleFormats { get; init; }

    public static ClientProfile Default { get; } = new();

    public bool SupportsHdrFormat(HdrFormat format)
        => format == HdrFormat.None || (HdrFormats is { } formats ? formats.Contains(format.ToApi(), StringComparer.OrdinalIgnoreCase) : SupportsHdr);
}

/// <summary>Request limits and track choices; <see cref="BurnInSubtitle"/> lets a transcode overlay a selected image-based subtitle onto the video.</summary>
public sealed record TranscodeLimits(
    int? MaxHeight = null, int? MaxBitrateKbps = null, int? AudioStreamIndex = null, int? SubtitleStreamIndex = null, bool BurnInSubtitle = false,
    IReadOnlyList<int>? AudioRenditions = null);

/// <summary>How a stream reaches the player: the original file, a stream copy into HLS, or a full re-encode.</summary>
public enum DeliveryMode
{
    Direct,
    Remux,
    Transcode,
}

public enum ModePreference
{
    Auto,
    Remux,
    Transcode,
}

public static class DeliveryModeNames
{
    public static string ToApi(this DeliveryMode mode) => mode switch
    {
        DeliveryMode.Direct => "direct",
        DeliveryMode.Remux => "remux",
        _ => "transcode",
    };

    public static bool TryParsePreference(string? value, out ModePreference preference)
    {
        preference = (value ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "" or "auto" => ModePreference.Auto,
            "remux" or "copy" => ModePreference.Remux,
            "transcode" => ModePreference.Transcode,
            _ => (ModePreference)(-1),
        };
        return Enum.IsDefined(preference);
    }

    public static string ToApi(this HdrFormat format) => format switch
    {
        HdrFormat.Hdr10 => "hdr10",
        HdrFormat.Hlg => "hlg",
        HdrFormat.DolbyVision => "dolbyvision",
        _ => "none",
    };
}

/// <summary>A stable, machine-readable reason with an English message; <see cref="Params"/> carry the values for localized texts.</summary>
public sealed record PlanReason(string Code, string Message, IReadOnlyDictionary<string, string>? Params = null)
{
    public static PlanReason Of(string code, string message, params (string Key, object? Value)[] parameters)
        => new(code, message, parameters.Length == 0
            ? null
            : parameters.Where(p => p.Value is not null)
                .ToDictionary(p => p.Key, p => Convert.ToString(p.Value, CultureInfo.InvariantCulture)!, StringComparer.Ordinal));
}

/// <summary>How one source subtitle stream reaches the player in this plan.</summary>
public sealed record SubtitlePlan(SourceSubtitleStream Stream, string DeliveredAs, string? Language, string Name)
{
    public const string WebVtt = "webvtt";
    public const string Embedded = "embedded";
    public const string BurnedIn = "burnedIn";
    public const string None = "none";

    public bool Delivered => DeliveredAs == WebVtt;
}

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

public sealed record AudioTarget(
    int SourceIndex,
    string SourceCodec,
    bool Copy,
    int Channels,
    int BitrateKbps,
    int? SampleRate,
    string Codec = "aac",
    string CodecsTag = "mp4a.40.2");

/// <summary>One HLS audio rendition of a demuxed delivery; <see cref="TrackId"/> is its track in the muxed fMP4 the session splits.</summary>
public sealed record AudioRendition(AudioTarget Target, string? Language, string Name, bool IsDefault, uint TrackId, double SourceStartSeconds, int? SourceSampleRate)
{
    public string Id => Target.SourceIndex.ToString(System.Globalization.CultureInfo.InvariantCulture);
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
    public DeliveryMode Mode { get; init; } = DeliveryMode.Transcode;

    /// <summary>Why this mode was chosen (or why the cheaper modes were not possible).</summary>
    public IReadOnlyList<PlanReason> Reasons { get; init; } = [];
    public IReadOnlyList<PlanReason> DirectPlayReasons { get; init; } = [];
    public bool RemuxPossible { get; init; }
    public IReadOnlyList<PlanReason> RemuxBlockers { get; init; } = [];

    /// <summary>HLS VIDEO-RANGE of a stream copy: SDR, PQ or HLG.</summary>
    public string VideoRange { get; init; } = "SDR";
    public IReadOnlyList<SubtitlePlan> Subtitles { get; init; } = [];

    /// <summary>The image-based subtitle a transcode overlays onto the video (software decode path).</summary>
    public SourceSubtitleStream? BurnIn { get; init; }
    public KeyframeIndex? KeyframeIndex { get; init; }
    public SegmentTimeline? RemuxTimeline { get; init; }
    public int? PeakBandwidthBitsPerSecond { get; init; }
    public int? AverageBandwidthBitsPerSecond { get; init; }

    public bool Scales => Video.Width != SourceVideo.Width || Video.Height != SourceVideo.Height;

    public int BandwidthBitsPerSecond => (Video.BitrateKbps + (Audio?.BitrateKbps ?? 0)) * 1000;

    /// <summary>Audio renditions of one group (default first in source order); empty means the audio is muxed into the video segments.</summary>
    public IReadOnlyList<AudioRendition> AudioRenditions { get; init; } = [];

    public bool DemuxedAudio => AudioRenditions.Count > 0;

    public string CodecsAttribute => DemuxedAudio
        ? string.Join(',', AudioRenditions.Select(r => r.Target.CodecsTag).Distinct().Prepend(Video.CodecsTag))
        : Audio is null ? Video.CodecsTag : $"{Video.CodecsTag},{Audio.CodecsTag}";
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

        var blockers = DirectPlayBlockers(media, video, audio, client, limits);

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
        var burnIn = limits.BurnInSubtitle && SelectSubtitle(media, limits.SubtitleStreamIndex) is { TextBased: false } image ? image : null;
        var (hwDecode, hwDecodeReason) = burnIn is not null
            ? (false, "Burning in an image subtitle overlays it on the CPU.")
            : DecideHardwareDecode(video, settings, accel, accelCap, deinterlace);
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
            DirectPlayBlockers = blockers.Select(b => b.Message).ToList(),
            DirectPlayReasons = blockers,
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
            BurnIn = burnIn,
        };
    }

    /// <summary>Target segment length of stream copies; boundaries move to the next keyframe.</summary>
    public const double RemuxSegmentTargetSeconds = 6;

    private static readonly string[] RemuxVideoCodecs = ["h264", "hevc", "av1"];
    private static readonly string[] CopyableAudioCodecs = ["aac", "ac3", "eac3", "flac", "opus"];

    /// <summary>Chooses direct → remux → transcode; <paramref name="allowDirect"/> is false when HLS is required, <paramref name="remuxUnavailable"/> forces a transcode.</summary>
    public static TranscodePlan Decide(
        SourceMediaInfo media,
        ClientProfile client,
        TranscodeLimits limits,
        TranscodingSettings settings,
        FfmpegCapabilities capabilities,
        ModePreference preference,
        bool allowDirect,
        PlanReason? remuxUnavailable = null)
    {
        var transcode = Plan(media, client, limits, settings, capabilities);
        var video = transcode.SourceVideo;
        var remuxBlockers = RemuxBlockers(media, video, client, limits);
        if (remuxUnavailable is not null)
            remuxBlockers.Add(remuxUnavailable);
        var remuxPossible = remuxBlockers.Count == 0;
        var videoRange = (video.BaseLayerHdr ?? HdrFormat.None) switch
        {
            HdrFormat.Hdr10 => "PQ",
            HdrFormat.Hlg => "HLG",
            _ => "SDR",
        };

        if (allowDirect && preference == ModePreference.Auto && transcode.DirectPlayPossible)
        {
            var original = SelectAudio(media, limits.AudioStreamIndex);
            return Untouched(transcode, media, "Direct play") with
            {
                Mode = DeliveryMode.Direct,
                Reasons = [PlanReason.Of("direct_play", "The player can play the original file as it is.")],
                RemuxPossible = remuxPossible,
                RemuxBlockers = remuxBlockers,
                VideoRange = video.Hdr == HdrFormat.None ? "SDR" : (video.BaseLayerHdr ?? HdrFormat.Hdr10) == HdrFormat.Hlg ? "HLG" : "PQ",
                Subtitles = PlanSubtitles(media, DeliveryMode.Direct),
                Audio = original is null ? null : new AudioTarget(original.Index, original.Codec, true, original.Channels, CopiedAudioKbps(original), null,
                    original.Codec, CodecStrings.Audio(original.Codec, original.Profile)),
                Encoder = "none",
            };
        }

        if (preference != ModePreference.Transcode && remuxPossible)
        {
            var audio = SelectAudio(media, limits.AudioStreamIndex);
            PlanReason? audioReason = null;
            var audioTarget = audio is null ? null : PlanRemuxAudio(audio, client, settings, capabilities, out audioReason);
            var reasons = new List<PlanReason>(transcode.DirectPlayReasons);
            if (reasons.Count == 0)
                reasons.Add(PlanReason.Of("hls_requested", "The player asked for HLS; the original video is copied without re-encoding."));
            if (audioReason is not null)
                reasons.Add(audioReason);
            var subtitles = PlanSubtitles(media, DeliveryMode.Remux);
            if (SelectSubtitle(media, limits.SubtitleStreamIndex) is { TextBased: false } image)
            {
                reasons.Add(PlanReason.Of("subtitle_not_deliverable",
                    $"Subtitle stream {image.Index} ({image.Codec}) is image-based and cannot be delivered with a remux; play the original file (VLC) to see it.",
                    ("index", image.Index), ("codec", image.Codec), ("mode", "remux")));
            }
            return Untouched(transcode, media, "Stream copy") with
            {
                Mode = DeliveryMode.Remux,
                Reasons = reasons,
                RemuxPossible = true,
                RemuxBlockers = [],
                VideoRange = videoRange,
                Subtitles = subtitles,
                Audio = audioTarget,
                AudioRenditions = PlanRenditions(media, limits, audioTarget, a => PlanRemuxAudio(a, client, settings, capabilities, out _)),
                Encoder = "copy",
            };
        }

        var why = new List<PlanReason>();
        if (preference == ModePreference.Transcode)
            why.Add(PlanReason.Of("transcode_requested", "A full transcode was requested."));
        why.AddRange(remuxBlockers);
        if (transcode.BurnIn is { } burned)
        {
            why.Add(PlanReason.Of("subtitle_burned_in",
                $"Subtitle stream {burned.Index} ({burned.Codec}) is image-based and is burned into the transcoded video.",
                ("index", burned.Index), ("codec", burned.Codec)));
        }
        else if (SelectSubtitle(media, limits.SubtitleStreamIndex) is { TextBased: false } selected)
        {
            why.Add(PlanReason.Of("subtitle_not_deliverable",
                $"Subtitle stream {selected.Index} ({selected.Codec}) is image-based and this transcode does not burn it in (burn-in not requested); play the original file (VLC) or request burn-in to see it.",
                ("index", selected.Index), ("codec", selected.Codec), ("mode", "transcode")));
        }
        return transcode with
        {
            Mode = DeliveryMode.Transcode,
            Reasons = why,
            RemuxPossible = remuxPossible,
            RemuxBlockers = remuxBlockers,
            Subtitles = PlanSubtitles(media, DeliveryMode.Transcode, transcode.BurnIn),
            AudioRenditions = PlanRenditions(media, limits, transcode.Audio, a => PlanAudio(a, client, settings)),
        };
    }

    public const int MaxAudioRenditions = 4;

    /// <summary>Two or more requested audio streams become renditions (the selected one is the default); otherwise the audio stays muxed.</summary>
    internal static IReadOnlyList<AudioRendition> PlanRenditions(
        SourceMediaInfo media, TranscodeLimits limits, AudioTarget? selected, Func<SourceAudioStream, AudioTarget> plan)
    {
        if (selected is null || limits.AudioRenditions is not { Count: > 0 } requested)
            return [];
        var streams = requested.Prepend(selected.SourceIndex).Distinct()
            .Select(i => media.Audio.FirstOrDefault(a => a.Index == i)
                ?? throw new TranscodePlanningException("unknown_audio_stream", $"Audio stream {i} does not exist in the source."))
            .Take(MaxAudioRenditions)
            .ToList();
        if (streams.Count < 2)
            return [];
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return streams.OrderBy(a => a.Index).Select((a, i) =>
        {
            var baseName = SanitizeName(a.Title) ?? WebVttSubtitles.LanguageName(a.Language) ?? $"Audio {a.Index}";
            var name = baseName;
            for (var n = 2; !names.Add(name); n++)
                name = $"{baseName} {n}";
            return new AudioRendition(
                a.Index == selected.SourceIndex ? selected : plan(a),
                WebVttSubtitles.Bcp47(a.Language),
                name,
                a.Index == selected.SourceIndex,
                (uint)(i + 2),
                a.StartTime is { } start ? Math.Max(0, start - media.StartTime) : 0,
                a.SampleRate);
        }).ToList();
    }

    /// <summary>The server neither decodes nor encodes the video: the target describes the original stream.</summary>
    private static TranscodePlan Untouched(TranscodePlan transcode, SourceMediaInfo media, string what)
    {
        var video = transcode.SourceVideo;
        var frameRate = video.FrameRate is > 0 and <= 240 ? video.FrameRate.Value : transcode.Video.FrameRate;
        var videoKbps = (int)Math.Max(1, (media.EstimatedVideoBitRate ?? 0) / 1000);
        return transcode with
        {
            Video = new VideoTarget(video.Codec, video.Width, video.Height, videoKbps, frameRate, LevelName(video), CodecStrings.VideoFromProbe(video)),
            Acceleration = HardwareAcceleration.None,
            HardwareDecode = false,
            HardwareDecodeReason = $"{what}: the video is not decoded.",
            HardwareEncode = false,
            HardwareEncodeReason = $"{what}: the video is not encoded.",
            ToneMap = ToneMapMode.NotNeeded,
            Deinterlace = false,
            Warnings = [],
            BurnIn = null,
        };
    }

    /// <summary>Why the video cannot simply be copied for this client (empty when a remux works).</summary>
    internal static List<PlanReason> RemuxBlockers(SourceMediaInfo media, SourceVideoStream video, ClientProfile client, TranscodeLimits limits)
    {
        var blockers = new List<PlanReason>();
        if (!RemuxVideoCodecs.Contains(video.Codec))
        {
            blockers.Add(PlanReason.Of("video_codec_not_remuxable",
                $"Video codec '{video.Codec}' cannot be carried in fragmented-MP4 HLS.", ("codec", video.Codec)));
        }
        else if (!Contains(client.VideoCodecs, video.Codec))
        {
            blockers.Add(PlanReason.Of("video_codec_unsupported", $"Video codec '{video.Codec}' is not supported by the player.", ("codec", video.Codec)));
        }
        var pixelFormat = video.PixelFormat ?? "yuv420p";
        var fourTwoZero = pixelFormat is "yuv420p" or "yuvj420p" or "yuv420p10le" or "nv12" or "p010le";
        if (RemuxVideoCodecs.Contains(video.Codec) && (!fourTwoZero || video.BitDepth > (video.Codec == "h264" ? 8 : 10)))
        {
            blockers.Add(PlanReason.Of("video_profile_unsupported",
                $"{video.Codec} {video.Profile ?? pixelFormat} ({video.BitDepth}-bit {pixelFormat}) is not decodable by typical players.",
                ("codec", video.Codec), ("profile", video.Profile ?? pixelFormat)));
        }
        if (video.BitDepth > 8 && !client.Supports10Bit)
            blockers.Add(PlanReason.Of("bit_depth_unsupported", $"{video.BitDepth}-bit video is not supported by the player.", ("bitDepth", video.BitDepth)));
        if (video.Hdr == HdrFormat.DolbyVision && video.BaseLayerHdr is null)
        {
            blockers.Add(PlanReason.Of("dolby_vision_profile_unsupported",
                $"Dolby Vision profile {video.DolbyVisionProfile?.ToString(CultureInfo.InvariantCulture) ?? "?"} has no base layer other players can show.",
                ("profile", video.DolbyVisionProfile)));
        }
        else if (video.BaseLayerHdr is { } range && range != HdrFormat.None && !client.SupportsHdrFormat(range))
        {
            blockers.Add(PlanReason.Of("hdr_unsupported", $"{range} HDR output is not supported by the player.", ("hdr", range.ToApi())));
        }
        if (video.Interlaced)
            blockers.Add(PlanReason.Of("interlaced", "Interlaced video needs deinterlacing."));
        blockers.AddRange(LimitReasons(media, video, limits));
        return blockers;
    }

    /// <summary>Copy the audio when the player takes it as is; otherwise E-AC-3 5.1 → AC-3 5.1 → AAC stereo, within maxAudioChannels.</summary>
    internal static AudioTarget PlanRemuxAudio(
        SourceAudioStream audio, ClientProfile client, TranscodingSettings settings, FfmpegCapabilities capabilities, out PlanReason reason)
    {
        var copyable = CopyableAudioCodecs.Contains(audio.Codec) && (audio.Codec != "aac" || audio.Profile is null or "LC" or "HE-AAC" or "HE-AACv2");
        if (copyable && Contains(client.AudioCodecs, audio.Codec) && audio.Channels <= client.MaxAudioChannels)
        {
            reason = PlanReason.Of("audio_copied", $"Audio '{audio.Codec}' {audio.Channels} ch is copied.", ("codec", audio.Codec), ("channels", audio.Channels));
            return new AudioTarget(audio.Index, audio.Codec, true, audio.Channels, CopiedAudioKbps(audio), null, audio.Codec,
                CodecStrings.Audio(audio.Codec, audio.Profile));
        }

        var surround = audio.Channels > 2 && client.MaxAudioChannels >= 6;
        string codec;
        int channels, bitrate;
        if (surround && Contains(client.AudioCodecs, "eac3") && capabilities.Encoders.Contains("eac3"))
            (codec, channels, bitrate) = ("eac3", 6, 640);
        else if (surround && Contains(client.AudioCodecs, "ac3") && capabilities.Encoders.Contains("ac3"))
            (codec, channels, bitrate) = ("ac3", 6, 640);
        else
            (codec, channels, bitrate) = ("aac", Math.Clamp(audio.Channels, 1, 2), audio.Channels == 1 ? Math.Min(128, settings.AudioBitrateKbps) : settings.AudioBitrateKbps);

        var why = !CopyableAudioCodecs.Contains(audio.Codec) ? $"'{audio.Codec}' cannot be carried in HLS"
            : !Contains(client.AudioCodecs, audio.Codec) ? $"the player does not decode '{audio.Codec}'"
            : $"{audio.Channels} channels exceed the player's {client.MaxAudioChannels}";
        reason = PlanReason.Of("audio_converted", $"Audio '{audio.Codec}' {audio.Channels} ch is converted to '{codec}' {channels} ch because {why}.",
            ("from", audio.Codec), ("to", codec), ("channels", channels));
        int? sampleRate = codec == "aac"
            ? audio.SampleRate is > 48_000 or < 16_000 ? 48_000 : null
            : audio.SampleRate is 48_000 or 44_100 or 32_000 ? null : 48_000;
        return new AudioTarget(audio.Index, audio.Codec, false, channels, bitrate, sampleRate, codec, CodecStrings.Audio(codec, null));
    }

    internal static IReadOnlyList<SubtitlePlan> PlanSubtitles(SourceMediaInfo media, DeliveryMode mode, SourceSubtitleStream? burnIn = null)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return media.Subtitles.Take(16).Select(stream =>
        {
            var language = WebVttSubtitles.Bcp47(stream.Language);
            var baseName = SanitizeName(stream.Title) ?? WebVttSubtitles.LanguageName(stream.Language) ?? $"Subtitle {stream.Index}";
            if (stream.IsForced && !baseName.Contains("forced", StringComparison.OrdinalIgnoreCase))
                baseName += " (forced)";
            var name = baseName;
            for (var n = 2; !names.Add(name); n++)
                name = $"{baseName} {n}";
            var delivered = mode switch
            {
                DeliveryMode.Direct => SubtitlePlan.Embedded,
                DeliveryMode.Transcode when burnIn?.Index == stream.Index => SubtitlePlan.BurnedIn,
                DeliveryMode.Remux or DeliveryMode.Transcode when stream.TextBased => SubtitlePlan.WebVtt,
                _ => SubtitlePlan.None,
            };
            return new SubtitlePlan(stream, delivered, language, name);
        }).ToList();
    }

    /// <summary>Completes a remux plan with its keyframe timeline, the exact CODECS string and bandwidth figures from the index.</summary>
    public static TranscodePlan FinalizeRemux(TranscodePlan plan, SourceMediaInfo media, KeyframeIndex index, long? totalBytes)
    {
        var keyframes = index.Keyframes.Select(k => k - media.StartTime).ToList();
        var timeline = SegmentTimeline.FromKeyframes(keyframes, media.DurationSeconds, RemuxSegmentTargetSeconds);
        var codecs = CodecStrings.Video(plan.SourceVideo, index.Config);
        var (peak, average) = Bandwidth(timeline, keyframes, index.Container, totalBytes, plan, media);
        return plan with
        {
            KeyframeIndex = index,
            RemuxTimeline = timeline,
            Video = plan.Video with { CodecsTag = codecs },
            PeakBandwidthBitsPerSecond = peak,
            AverageBandwidthBitsPerSecond = average,
        };
    }

    private static (int Peak, int Average) Bandwidth(
        SegmentTimeline timeline, List<double> keyframes, ContainerIndex index, long? totalBytes, TranscodePlan plan, SourceMediaInfo media)
    {
        var audioBps = index.OffsetsCoverAllStreams ? DeliveredMinusSourceAudioBps(plan.Audio, media) : (plan.Audio?.BitrateKbps ?? 0) * 1000d;
        var fallbackAverage = Math.Max(100_000d, plan.BandwidthBitsPerSecond);
        if (index.ByteOffsets is not { Count: > 0 } offsets || offsets.Count != keyframes.Count)
            return ((int)Math.Min(int.MaxValue, fallbackAverage * 2), (int)Math.Min(int.MaxValue, fallbackAverage));

        var byTime = new Dictionary<double, long>();
        for (var i = 0; i < keyframes.Count; i++)
            byTime.TryAdd(Math.Round(keyframes[i], 6), offsets[i]);
        long OffsetAt(int segment) => segment == 0 ? offsets[0] : byTime.GetValueOrDefault(timeline.StartOf(segment), -1);

        double peak = 0, bytes = 0, seconds = 0;
        for (var i = 0; i + 1 < timeline.Count; i++)
        {
            var (from, to) = (OffsetAt(i), OffsetAt(i + 1));
            if (from < 0 || to < from || timeline.Durations[i] <= 0)
                continue;
            var bps = (to - from) * 8d / timeline.Durations[i] + audioBps;
            peak = Math.Max(peak, bps);
            bytes += to - from;
            seconds += timeline.Durations[i];
        }
        if (index.OffsetsCoverAllStreams && totalBytes is { } total && OffsetAt(timeline.Count - 1) is var last and >= 0 && total > last)
        {
            bytes += total - last;
            seconds += timeline.Durations[^1];
        }
        if (peak <= 0 || seconds <= 0)
            return ((int)Math.Min(int.MaxValue, fallbackAverage * 2), (int)Math.Min(int.MaxValue, fallbackAverage));
        var average = bytes * 8 / seconds + audioBps;
        return ((int)Math.Min(int.MaxValue, Math.Ceiling(peak * 1.1)), (int)Math.Min(int.MaxValue, Math.Ceiling(average)));
    }

    /// <summary>Byte offsets over all streams include every source audio track; constant-rate tracks with a known rate are swapped for the delivered audio.</summary>
    private static double DeliveredMinusSourceAudioBps(AudioTarget? delivered, SourceMediaInfo media)
    {
        static long KnownConstantBps(SourceAudioStream? audio)
            => audio is { Codec: "ac3" or "eac3" or "dts", BitRate: long bps and > 0 } && audio.Profile?.Contains("HD", StringComparison.Ordinal) != true ? bps : 0;
        var removed = media.Audio.Sum(KnownConstantBps);
        var source = delivered is null ? null : media.Audio.FirstOrDefault(a => a.Index == delivered.SourceIndex);
        var added = delivered is null ? 0 : delivered.Copy ? KnownConstantBps(source) : delivered.BitrateKbps * 1000d;
        return added - removed;
    }

    private static int CopiedAudioKbps(SourceAudioStream audio)
        => audio.BitRate is { } bps and > 0 ? (int)(bps / 1000) : audio.Codec switch
        {
            "eac3" or "ac3" => audio.Channels > 2 ? 640 : 192,
            "flac" => 1_000,
            _ => 192,
        };

    private static string LevelName(SourceVideoStream video)
    {
        if (video.Level is not { } level)
            return "—";
        return video.Codec switch
        {
            "h264" => (level / 10d).ToString("0.0", CultureInfo.InvariantCulture),
            "hevc" => (level / 30d).ToString("0.0", CultureInfo.InvariantCulture),
            "av1" => string.Create(CultureInfo.InvariantCulture, $"{2 + level / 4}.{level % 4}"),
            _ => level.ToString(CultureInfo.InvariantCulture),
        };
    }

    private static string? SanitizeName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        var cleaned = new string(value.Where(c => c != '"' && !char.IsControl(c)).ToArray()).Trim();
        return cleaned.Length == 0 ? null : cleaned.Length > 64 ? cleaned[..64] : cleaned;
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

    private static List<PlanReason> DirectPlayBlockers(
        SourceMediaInfo media, SourceVideoStream video, SourceAudioStream? audio, ClientProfile client, TranscodeLimits limits)
    {
        var blockers = new List<PlanReason>();
        var container = ContainerFamily(media.Container);
        if (!Contains(client.Containers, container))
            blockers.Add(PlanReason.Of("container_unsupported", $"Container '{container}' is not supported by the player.", ("container", container)));
        if (!Contains(client.VideoCodecs, video.Codec))
            blockers.Add(PlanReason.Of("video_codec_unsupported", $"Video codec '{video.Codec}' is not supported by the player.", ("codec", video.Codec)));
        if (video.BitDepth > 8 && !client.Supports10Bit)
            blockers.Add(PlanReason.Of("bit_depth_unsupported", $"{video.BitDepth}-bit video is not supported by the player.", ("bitDepth", video.BitDepth)));
        if (video.Hdr != HdrFormat.None && !client.SupportsHdrFormat(video.Hdr))
            blockers.Add(PlanReason.Of("hdr_unsupported", $"{video.Hdr} HDR output is not supported by the player.", ("hdr", video.Hdr.ToApi())));
        if (video.Interlaced)
            blockers.Add(PlanReason.Of("interlaced", "Interlaced video needs deinterlacing."));
        if (audio is not null && !Contains(client.AudioCodecs, audio.Codec))
            blockers.Add(PlanReason.Of("audio_codec_unsupported", $"Audio codec '{audio.Codec}' is not supported by the player.", ("codec", audio.Codec)));
        if (SelectSubtitle(media, limits.SubtitleStreamIndex) is { } subtitle && client.SubtitleFormats is { } formats
            && !SubtitleFormatNames(subtitle.Codec).Any(name => Contains(formats, name)))
        {
            blockers.Add(PlanReason.Of("subtitle_format_unsupported", $"Subtitle format '{subtitle.Codec}' is not supported by the player.",
                ("codec", subtitle.Codec), ("index", subtitle.Index)));
        }
        blockers.AddRange(LimitReasons(media, video, limits));
        return blockers;
    }

    private static IEnumerable<PlanReason> LimitReasons(SourceMediaInfo media, SourceVideoStream video, TranscodeLimits limits)
    {
        if (limits.MaxHeight is { } maxHeight && video.Height > maxHeight)
        {
            yield return PlanReason.Of("resolution_exceeds_limit", $"Resolution {video.Height}p exceeds the {maxHeight}p limit.",
                ("height", video.Height), ("max", maxHeight));
        }
        if (limits.MaxBitrateKbps is { } maxBitrate && media.BitRate is { } bps && bps / 1000 > maxBitrate)
        {
            yield return PlanReason.Of("bitrate_exceeds_limit", $"Bitrate {bps / 1000} kbps exceeds the {maxBitrate} kbps limit.",
                ("kbps", bps / 1000), ("max", maxBitrate));
        }
    }

    /// <summary>Names a client may use for a subtitle codec (ffprobe calls SRT "subrip", PGS "hdmv_pgs_subtitle", …).</summary>
    internal static IEnumerable<string> SubtitleFormatNames(string codec) => codec switch
    {
        "subrip" => ["subrip", "srt"],
        "ass" or "ssa" => ["ass", "ssa"],
        "webvtt" => ["webvtt", "vtt"],
        "mov_text" => ["mov_text", "tx3g"],
        "hdmv_pgs_subtitle" => ["hdmv_pgs_subtitle", "pgs", "pgssub"],
        "dvd_subtitle" => ["dvd_subtitle", "vobsub", "dvdsub"],
        "dvb_subtitle" => ["dvb_subtitle", "dvbsub"],
        _ => [codec],
    };

    internal static SourceSubtitleStream? SelectSubtitle(SourceMediaInfo media, int? requestedIndex)
    {
        if (requestedIndex is not { } index || index < 0)
            return null;
        return media.Subtitles.FirstOrDefault(s => s.Index == index)
               ?? throw new TranscodePlanningException("unknown_subtitle_stream", $"Subtitle stream {index} does not exist in the source.");
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
