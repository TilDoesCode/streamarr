using System.Globalization;
using System.Text.RegularExpressions;
using Streamarr.Core.Parser;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Catalog;

public sealed record PlaybackPrediction(string Method, IReadOnlyList<PredictionReasonDto> Reasons);

/// <summary>The compact device profile a client may send with a versions request.</summary>
public sealed record DeviceHints(ClientProfile Client, TranscodeLimits Limits);

/// <summary>Guesses a version's playback method by running the transcode planner on a source built from its name; assumptions are reported.</summary>
public sealed partial class PlaybackPredictor(TranscodingSettingsService settings)
{
    private static readonly FfmpegCapabilities NoProbe = new();

    [GeneratedRegex(@"(?<![A-Za-z0-9])MP4(?![A-Za-z0-9])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Mp4Pattern();

    public PlaybackPrediction Predict(ParsedReleaseInfo parsed, int? estimatedKbps, int? runtimeMinutes, DeviceHints device, bool allowTranscoding)
    {
        var notes = new List<PredictionReasonDto>();
        var codec = VideoCodec(parsed.VideoCodec);
        if (codec is null)
            return new PlaybackPrediction("unknown", [Reason("video_codec_unknown")]);

        var height = Height(parsed.Resolution);
        if (height is null)
        {
            height = 1080;
            notes.Add(Reason("resolution_assumed", ("height", "1080")));
        }

        var mp4 = Mp4Pattern().IsMatch(parsed.ReleaseName);
        if (!mp4)
            notes.Add(Reason("container_assumed", ("container", "mkv")));

        var formats = parsed.HdrFormats;
        var hdr = formats.Contains("DV") ? HdrFormat.DolbyVision
            : formats.Contains("HDR10+") || formats.Contains("HDR10") ? HdrFormat.Hdr10
            : formats.Contains("HLG") ? HdrFormat.Hlg
            : HdrFormat.None;
        int? dolbyVisionCompatibility = hdr != HdrFormat.DolbyVision ? null
            : formats.Contains("HDR10") || formats.Contains("HDR10+") ? 1
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

        var media = new SourceMediaInfo
        {
            DurationSeconds = (runtimeMinutes is > 0 ? runtimeMinutes.Value : 90) * 60,
            BitRate = estimatedKbps is > 0 ? estimatedKbps.Value * 1000L : null,
            Container = mp4 ? "mov,mp4,m4a,3gp,3g2,mj2" : "matroska,webm",
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
                DolbyVisionProfile = dolbyVisionCompatibility is null ? null : 8,
                DolbyVisionCompatibility = dolbyVisionCompatibility,
            },
            Audio = audio is null ? [] : [new SourceAudioStream { Index = 1, Codec = audio, Channels = Channels(parsed.AudioChannels) }],
        };

        TranscodePlan plan;
        var current = settings.Current;
        try
        {
            plan = TranscodePlanner.Decide(media, device.Client, device.Limits, current, NoProbe, ModePreference.Auto, allowDirect: true);
        }
        catch (TranscodePlanningException e)
        {
            return new PlaybackPrediction("unknown", [.. notes, Reason(e.Code)]);
        }

        var method = plan.Mode.ToApi();
        notes.AddRange(plan.Reasons.Select(r => new PredictionReasonDto { Code = r.Code, Params = r.Params }));
        if (method == "transcode" && !allowTranscoding)
            notes.Add(Reason("transcoding_not_allowed"));
        if (method != "direct" && !current.Enabled)
            notes.Add(Reason("transcoding_disabled"));
        return new PlaybackPrediction(method, notes);
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

    private static int? Height(string? resolution) => resolution switch
    {
        "2160p" => 2160,
        "1080p" or "1080i" => 1080,
        "720p" => 720,
        "576p" => 576,
        "540p" => 540,
        "480p" or "SD" => 480,
        "360p" => 360,
        _ => null,
    };

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
