using System.Globalization;
using System.Text.RegularExpressions;
using Streamarr.Core.Parser;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>The decider's first choice for a version: method, reasons, and what the device shows (output height, <c>sdr</c>/<c>hdr10</c>/<c>hlg</c>/<c>dolbyvision</c>).</summary>
public sealed record PlaybackPrediction(string Method, IReadOnlyList<PredictionReasonDto> Reasons, int? Height = null, string? Hdr = null);

/// <summary>The compact device profile a client may send with a versions request.</summary>
public sealed record DeviceHints(ClientProfile Client, TranscodeLimits Limits)
{
    /// <summary>The native engine the hints describe (every non-H.264 codec shares the 10-bit and HDR declaration), plus VLC when available.</summary>
    public DeviceCaps ToCaps(EngineCaps? vlc)
    {
        var depth = Client.Supports10Bit ? 10 : 8;
        var hdr = (Client.HdrFormats ?? []).Select(h => h == "dv" ? "dolbyvision" : h).ToList();
        var native = new EngineCaps(
            EngineCaps.Native,
            Client.Containers.Select(DeviceNames.Container).Distinct().ToList(),
            Client.VideoCodecs.Select(DeviceNames.Video).Distinct()
                .Select(c => new VideoCaps(c, null, Limits.MaxHeight, c == "h264" ? 8 : depth, c == "h264" ? [] : hdr)).ToList(),
            Client.AudioCodecs.Select(DeviceNames.Audio).Distinct().Select(c => new AudioCaps(c, null, Client.PassesThrough(c))).ToList(),
            null,
            true,
            Client.MaxAudioChannels);
        // VLC decodes to the same audio output as the native engine (the app's profile gives both its channel count)
        return new DeviceCaps("web", native, vlc is null ? null : vlc with { MaxAudioChannels = Client.MaxAudioChannels }, Limits.MaxBitrateKbps);
    }
}

/// <summary>What the playback decider needs to rank versions for one device (the full profile of a playback, or the compact hints).</summary>
public sealed record PlayContext(DeviceCaps Device, PlaybackPreferences Preferences, ServerHls Server);

/// <summary>How a version would play on a device, best first: <c>direct</c>, <c>remux</c>, <c>vlc</c>, <c>transcode</c>, <c>unknown</c>, <c>unplayable</c>.</summary>
public static class PlayClass
{
    public const string Direct = "direct";
    public const string Remux = "remux";
    public const string Vlc = "vlc";
    public const string Transcode = "transcode";
    public const string Unknown = "unknown";
    public const string Unplayable = "unplayable";

    public static bool WithoutTranscode(string value) => value is Direct or Remux or Vlc;

    public static int Order(string value) => value switch
    {
        Direct => 0,
        Remux => 1,
        Vlc => 2,
        Transcode => 3,
        Unknown => 4,
        _ => 5,
    };
}

/// <summary>Predicts a version's playback by running the playback decider (as a real start does) on a source built from its name; assumptions are reported.</summary>
public sealed partial class PlaybackPredictor(TranscodingSettingsService settings)
{
    private static readonly FfmpegCapabilities NoProbe = new();

    /// <summary>Failures that only say the server or the profile may not transcode: the version would need a transcode.</summary>
    private static readonly string[] TranscodePolicyCodes = ["transcoding_not_allowed", "transcoding_disabled", "ffmpeg_unavailable", "transcoding_unavailable"];

    [GeneratedRegex(@"(?<![A-Za-z0-9])MP4(?![A-Za-z0-9])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Mp4Pattern();

    /// <summary>The prediction for compact hints without a server probe: the decider with the transcoding settings and no ffmpeg encoders.</summary>
    public PlaybackPrediction Predict(
        ParsedReleaseInfo parsed, int? estimatedKbps, int? runtimeMinutes, DeviceHints device, bool allowTranscoding, string? knownContainer = null)
    {
        var current = settings.Current;
        var server = new ServerHls(current.Enabled, current.Enabled ? null : "transcoding_disabled", current, NoProbe);
        var play = new PlayContext(device.ToCaps(null), PlaybackPreferences.Default, server);
        return ClassifyAndExplain(parsed, estimatedKbps, runtimeMinutes, play, allowTranscoding, knownContainer).Prediction;
    }

    /// <summary>The playback decider's first choice for a version built from its name (see <see cref="PlayClass"/>).</summary>
    public string Classify(
        ParsedReleaseInfo parsed, int? estimatedKbps, int? runtimeMinutes, PlayContext play, bool allowTranscoding, string? knownContainer = null)
        => ClassifyAndExplain(parsed, estimatedKbps, runtimeMinutes, play, allowTranscoding, knownContainer).Class;

    /// <summary>
    /// The play class and the prediction shown for it, both from the decider's first viable candidate (the one a start would play): its
    /// method, the decision's, candidate's and plan's reasons, and the output height and range. Without a viable candidate the class is
    /// <c>unplayable</c>; the prediction says <c>transcode</c> when only the transcoding policy stands in the way, else <c>unknown</c>.
    /// </summary>
    public (string Class, PlaybackPrediction Prediction) ClassifyAndExplain(
        ParsedReleaseInfo parsed, int? estimatedKbps, int? runtimeMinutes, PlayContext play, bool allowTranscoding, string? knownContainer = null)
    {
        var notes = new List<PredictionReasonDto>();
        if (Source(parsed, estimatedKbps, runtimeMinutes, notes, knownContainer) is not { } media)
            return (PlayClass.Unknown, new PlaybackPrediction(PlayClass.Unknown, [Reason("video_codec_unknown")]));
        var decision = PlaybackDecider.Decide(media, play.Device, play.Preferences, allowTranscoding, play.Server, null, null, NoExclusions);
        notes.AddRange(Dtos(decision.Notes));
        if (decision.Viable.FirstOrDefault() is not { } best)
        {
            var transcode = decision.Skipped.LastOrDefault(s => s.Method == DeliveryMode.Transcode);
            var policy = transcode?.Reasons.FirstOrDefault(r => TranscodePolicyCodes.Contains(r.Code));
            var native = decision.Skipped.FirstOrDefault(s => s.Method == DeliveryMode.Remux) ?? decision.Skipped.FirstOrDefault();
            notes.AddRange(Dtos((native?.Reasons ?? []).Concat(transcode?.Reasons ?? []).DistinctBy(r => r.Code)));
            return (PlayClass.Unplayable, new PlaybackPrediction(policy is null ? PlayClass.Unknown : PlayClass.Transcode, notes));
        }
        var playClass = best switch
        {
            { Method: DeliveryMode.Direct } when best.Engine.Name == EngineCaps.Vlc => PlayClass.Vlc,
            { Method: DeliveryMode.Direct } => PlayClass.Direct,
            { Method: DeliveryMode.Remux } => PlayClass.Remux,
            _ => PlayClass.Transcode,
        };
        notes.AddRange(Dtos(best.Notes.Concat(best.Plan.Reasons)));
        var hdr = best.DisplayedHdr;
        return (playClass, new PlaybackPrediction(playClass, notes, best.Plan.Video.Height, hdr == HdrFormat.None ? "sdr" : hdr.ToApi()));
    }

    private static IEnumerable<PredictionReasonDto> Dtos(IEnumerable<PlanReason> reasons)
        => reasons.Select(r => new PredictionReasonDto { Code = r.Code, Params = r.Params });

    private static readonly IReadOnlySet<string> NoExclusions = new HashSet<string>();

    private static SourceMediaInfo? Source(
        ParsedReleaseInfo parsed, int? estimatedKbps, int? runtimeMinutes, List<PredictionReasonDto> notes, string? knownContainer)
    {
        var codec = VideoCodec(parsed.VideoCodec);
        if (codec is null)
            return null;

        var height = Height(parsed.Resolution);
        if (height is null)
        {
            height = 1080;
            notes.Add(Reason("resolution_assumed", ("height", "1080")));
        }

        var family = ReleaseContainerStore.Family(knownContainer) ?? (Mp4Pattern().IsMatch(parsed.ReleaseName) ? "mp4" : null);
        if (family is null)
            notes.Add(Reason("container_assumed", ("container", "mkv")));

        var formats = parsed.HdrFormats;
        var hdr = formats.Contains("DV") ? HdrFormat.DolbyVision
            : formats.Contains("HDR10+") || formats.Contains("HDR10") ? HdrFormat.Hdr10
            : formats.Contains("HLG") ? HdrFormat.Hlg
            : HdrFormat.None;
        // UHD Blu-ray Dolby Vision is the dual-layer profile 7 (HDR10 base, compatibility 6); WEB releases are profile 8.1/8.4
        var blurayDolbyVision = parsed.Source is "BluRay" or "Remux";
        int? dolbyVisionCompatibility = hdr != HdrFormat.DolbyVision ? null
            : formats.Contains("HDR10") || formats.Contains("HDR10+") ? blurayDolbyVision ? 6 : 1
            : formats.Contains("HLG") ? 4
            : null;
        if (hdr == HdrFormat.DolbyVision && dolbyVisionCompatibility is null)
            notes.Add(Reason("dolby_vision_profile_unknown"));

        var bitDepth = parsed.BitDepth ?? (hdr != HdrFormat.None ? 10 : 8);
        if (parsed.BitDepth is null && hdr == HdrFormat.None && codec is "hevc" or "av1")
            notes.Add(Reason("bit_depth_assumed", ("bitDepth", "8")));

        var audio = AudioCodec(parsed.AudioCodec);
        if (audio is null)
            notes.Add(Reason("audio_codec_unknown"));

        return new SourceMediaInfo
        {
            DurationSeconds = (runtimeMinutes is > 0 ? runtimeMinutes.Value : 90) * 60,
            BitRate = estimatedKbps is > 0 ? estimatedKbps.Value * 1000L : null,
            Container = ReleaseContainerStore.FormatName(family ?? "mkv"),
            Video = new SourceVideoStream
            {
                Index = 0,
                Codec = codec,
                Width = Width(height.Value),
                Height = height.Value,
                BitDepth = bitDepth,
                PixelFormat = bitDepth > 8 ? "yuv420p10le" : "yuv420p",
                FrameRate = 24,
                Hdr = hdr,
                ColorTransfer = hdr switch
                {
                    HdrFormat.Hdr10 => "smpte2084",
                    HdrFormat.Hlg => "arib-std-b67",
                    _ => null,
                },
                DolbyVisionProfile = dolbyVisionCompatibility switch { null => null, 6 => 7, _ => 8 },
                DolbyVisionCompatibility = dolbyVisionCompatibility,
            },
            Audio = audio is null ? [] : [new SourceAudioStream { Index = 1, Codec = audio, Channels = Channels(parsed.AudioChannels) }],
        };
    }

    private static PredictionReasonDto Reason(string code, params (string Key, string Value)[] parameters)
        => new()
        {
            Code = code,
            Params = parameters.Length == 0 ? null : parameters.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal),
        };

    private static string? VideoCodec(string? parsed) => VersionMapper.VideoCode(parsed) switch
    {
        "h264" => "h264",
        "hevc" => "hevc",
        "av1" => "av1",
        "vc1" => "vc1",
        "mpeg2" => "mpeg2video",
        "xvid" or "divx" => "mpeg4",
        _ => null,
    };

    private static string? AudioCodec(string? parsed) => VersionMapper.AudioCode(parsed) switch
    {
        null => null,
        "pcm" => "pcm_s16le",
        var code when code.StartsWith("dts", StringComparison.Ordinal) => "dts",
        var code => code,
    };

    private static int? Height(string? resolution) => VersionMapper.Height(resolution) is > 0 and var height ? height : null;

    private static int Width(int height) => height switch
    {
        576 or 480 => 720,
        _ => (int)Math.Round(height * 16 / 9d / 2) * 2,
    };

    private static int Channels(string? layout)
    {
        if (layout is not { Length: 3 } || !int.TryParse(layout.AsSpan(0, 1), NumberStyles.None, CultureInfo.InvariantCulture, out var front)
            || !int.TryParse(layout.AsSpan(2, 1), NumberStyles.None, CultureInfo.InvariantCulture, out var lfe))
        {
            return 2;
        }
        return front + lfe;
    }
}
