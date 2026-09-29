using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Playback;

public enum EnginePreference
{
    Auto,
    Native,
    Vlc,
}

public enum SubtitleMode
{
    Off,
    Forced,
    Always,
}

public sealed record VideoCaps(string Codec, int? MaxWidth, int? MaxHeight, int MaxBitDepth, IReadOnlyList<string> HdrFormats);

public sealed record AudioCaps(string Codec, int? MaxChannels, bool Passthrough);

/// <summary>One playback engine of a device with canonical codec and container names.</summary>
public sealed record EngineCaps(
    string Name,
    IReadOnlyList<string> Containers,
    IReadOnlyList<VideoCaps> Video,
    IReadOnlyList<AudioCaps> Audio,
    IReadOnlyList<string>? SubtitleFormats,
    bool Hls,
    int MaxAudioChannels,
    bool ToneMapsHdr = false)
{
    /// <summary>HDR formats an engine that tone-maps shows on any display.</summary>
    public static readonly string[] ToneMappedFormats = ["hdr10", "hlg"];

    public const string Native = "native";
    public const string Web = "web";
    public const string Vlc = "vlc";

    public VideoCaps? VideoFor(string codec) => Video.FirstOrDefault(v => v.Codec == DeviceNames.Video(codec));

    public AudioCaps? AudioFor(string codec) => Audio.FirstOrDefault(a => a.Codec == DeviceNames.Audio(codec));

    public bool RendersSubtitle(string codec)
        => SubtitleFormats is { } formats && TranscodePlanner.SubtitleFormatNames(codec).Any(name => formats.Contains(name, StringComparer.OrdinalIgnoreCase));

    /// <summary>What libVLC decodes on every platform when the device sends no VLC capabilities of its own.</summary>
    public static EngineCaps DefaultVlc { get; } = new(
        Vlc,
        ["mkv", "mp4", "webm", "ts", "mpeg", "avi", "ogg", "flv", "asf"],
        [
            new("h264", null, null, 10, []), new("hevc", null, null, 10, ["hdr10", "hlg"]), new("av1", null, null, 10, ["hdr10", "hlg"]),
            new("vp9", null, null, 10, ["hdr10", "hlg"]), new("vp8", null, null, 8, []), new("mpeg2video", null, null, 8, []),
            new("mpeg4", null, null, 8, []), new("vc1", null, null, 8, []),
        ],
        [
            new("aac", null, false), new("ac3", null, false), new("eac3", null, false), new("truehd", null, false), new("dts", null, false),
            new("flac", null, false), new("opus", null, false), new("mp3", null, false), new("vorbis", null, false), new("pcm_s16le", null, false),
            new("pcm_s24le", null, false), new("mp2", null, false),
        ],
        ["srt", "ass", "webvtt", "mov_text", "pgs", "vobsub", "dvbsub"],
        true,
        8,
        ToneMapsHdr: true);

    /// <summary>HDR formats this engine shows for a codec: what it renders plus, when it tone-maps, HDR10 and HLG of a 10-bit decoder.</summary>
    public IReadOnlyList<string> HdrFormatsFor(VideoCaps? entry)
        => entry is null ? []
            : ToneMapsHdr && entry.MaxBitDepth >= 10 ? entry.HdrFormats.Union(ToneMappedFormats, StringComparer.Ordinal).ToList()
            : entry.HdrFormats;

    /// <summary>The planner's view of this engine for one source video: per-codec bit depth and HDR formats of the source codec.</summary>
    public ClientProfile ClientFor(SourceVideoStream? video)
    {
        var entry = video is null ? null : VideoFor(video.Codec);
        var hdr = HdrFormatsFor(entry);
        return new ClientProfile
        {
            VideoCodecs = Video.Select(v => v.Codec).Distinct().ToList(),
            AudioCodecs = Audio.Select(a => a.Codec).Distinct().ToList(),
            Containers = Containers,
            MaxAudioChannels = MaxAudioChannels,
            Supports10Bit = entry is { MaxBitDepth: >= 10 },
            HdrFormats = hdr,
            SupportsHdr = hdr.Count > 0,
            SubtitleFormats = SubtitleFormats,
        };
    }
}

/// <summary>A validated device profile: the built-in engine and VLC (when available).</summary>
public sealed record DeviceCaps(string Platform, EngineCaps? Native, EngineCaps? Vlc, int? MaxBitrateKbps)
{
    public static readonly string[] Platforms = ["ios", "ipados", "tvos", "android", "androidtv", "web"];

    public static DeviceCaps Parse(DeviceProfileDto? dto)
    {
        if (dto is null)
            throw Invalid("'device' is required.");
        var platform = dto.Platform?.Trim().ToLowerInvariant();
        if (platform is null || !Platforms.Contains(platform))
            throw Invalid($"'device.platform' must be one of: {string.Join(", ", Platforms)}.");
        if (dto.Engines is not { Count: > 0 and <= 4 } engines)
            throw Invalid("'device.engines' must list 1 to 4 engines.");
        if (dto.MaxBitrateKbps is { } cap && cap is < 100 or > 1_000_000)
            throw Invalid("'device.maxBitrateKbps' must be between 100 and 1000000.");

        var parsed = new List<EngineCaps>();
        foreach (var engine in engines)
        {
            var caps = ParseEngine(engine);
            if (parsed.Any(p => p.Name == caps.Name))
                throw Invalid($"Engine '{caps.Name}' is listed twice.");
            parsed.Add(caps);
        }
        var native = parsed.FirstOrDefault(e => e.Name is EngineCaps.Native or EngineCaps.Web);
        var vlc = !dto.VlcAvailable ? null : parsed.FirstOrDefault(e => e.Name == EngineCaps.Vlc) ?? EngineCaps.DefaultVlc;
        if (native is null && vlc is null)
            throw Invalid("The device needs a native or web engine, or an available VLC engine.");
        return new DeviceCaps(platform, native, vlc, dto.MaxBitrateKbps);
    }

    private static EngineCaps ParseEngine(EngineProfileDto dto)
    {
        var name = dto.Engine?.Trim().ToLowerInvariant();
        if (name is not (EngineCaps.Native or EngineCaps.Web or EngineCaps.Vlc))
            throw Invalid("'engine' must be native, web or vlc.");
        var video = (dto.VideoCodecs ?? []).Take(Limit + 1).ToList();
        var audio = (dto.AudioCodecs ?? []).Take(Limit + 1).ToList();
        if (video.Count > Limit || audio.Count > Limit)
            throw Invalid($"At most {Limit} video and {Limit} audio codecs per engine.");
        if (dto.MaxAudioChannels is { } channels && channels is < 1 or > 16)
            throw Invalid("'maxAudioChannels' must be between 1 and 16.");

        var videoCaps = video.Select(v =>
        {
            var codec = DeviceNames.Video(Name(v.Codec, "videoCodecs[].codec"));
            if (v.MaxWidth is < 16 or > 16_384 || v.MaxHeight is < 16 or > 16_384 || v.MaxBitDepth is < 8 or > 16)
                throw Invalid($"Video codec '{codec}' has an out-of-range limit.");
            var depth = v.MaxBitDepth ?? (codec is "hevc" or "av1" or "vp9" ? 10 : 8);
            return new VideoCaps(codec, v.MaxWidth, v.MaxHeight, depth, Names(v.HdrFormats, "hdrFormats", 4).Select(h => h == "dv" ? "dolbyvision" : h).ToList());
        }).ToList();
        var audioCaps = audio.Select(a =>
        {
            var codec = DeviceNames.Audio(Name(a.Codec, "audioCodecs[].codec"));
            if (a.MaxChannels is < 1 or > 16)
                throw Invalid($"Audio codec '{codec}' has an out-of-range channel count.");
            return new AudioCaps(codec, a.MaxChannels, a.Passthrough);
        }).ToList();
        IReadOnlyList<string>? subtitles = dto.SubtitleFormats is null ? null : Names(dto.SubtitleFormats, "subtitleFormats", Limit).Select(DeviceNames.Subtitle).ToList();
        var maxChannels = dto.MaxAudioChannels ?? 2;
        return new EngineCaps(name, Names(dto.Containers, "containers", Limit).Select(DeviceNames.Container).Distinct().ToList(),
            videoCaps, audioCaps, subtitles, dto.Hls, maxChannels, dto.HdrToneMapping);
    }

    private const int Limit = 32;

    private static string Name(string? value, string field)
    {
        var trimmed = value?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > 32 || trimmed.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.'))
            throw Invalid($"'{field}' entries must be short codec or format names.");
        return trimmed;
    }

    private static IReadOnlyList<string> Names(IReadOnlyList<string>? values, string field, int limit)
    {
        if (values is null)
            return [];
        if (values.Count > limit)
            throw Invalid($"'{field}' lists at most {limit} names.");
        return values.Select(v => Name(v, field)).Distinct().ToList();
    }

    private static ViewerProblem Invalid(string message) => ViewerProblem.BadRequest("invalid_device_profile", message);
}

/// <summary>Canonical names for what devices call codecs and containers (ffprobe's names where they exist).</summary>
public static class DeviceNames
{
    public static string Video(string codec) => codec.ToLowerInvariant() switch
    {
        "avc" or "avc1" or "x264" => "h264",
        "h265" or "hvc1" or "hev1" or "x265" => "hevc",
        "av01" => "av1",
        "vp09" => "vp9",
        "mpeg2" => "mpeg2video",
        "xvid" or "divx" => "mpeg4",
        "wvc1" or "vc-1" => "vc1",
        var other => other,
    };

    public static string Audio(string codec) => codec.ToLowerInvariant() switch
    {
        "ec-3" or "e-ac-3" or "ddp" or "dd+" => "eac3",
        "ac-3" or "dd" => "ac3",
        "dca" or "dts-hd" or "dts-hd-ma" or "dtshd" or "dts-x" => "dts",
        "mlp" => "truehd",
        "mp4a" => "aac",
        var other => other,
    };

    public static string Container(string container) => container.ToLowerInvariant() switch
    {
        "matroska" => "mkv",
        "mov" or "m4v" => "mp4",
        "mpegts" or "m2ts" => "ts",
        "mpg" or "vob" or "mpegps" => "mpeg",
        var other => other,
    };

    public static string Subtitle(string format) => format.ToLowerInvariant() switch
    {
        "vtt" => "webvtt",
        "subrip" => "srt",
        "pgssub" or "hdmv_pgs_subtitle" or "sup" => "pgs",
        "dvdsub" or "dvd_subtitle" => "vobsub",
        var other => other,
    };
}
