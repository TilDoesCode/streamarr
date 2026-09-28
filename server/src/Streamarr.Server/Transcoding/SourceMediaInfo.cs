using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

public enum HdrFormat
{
    None,
    Hdr10,
    Hlg,
    DolbyVision,
}

public sealed record SourceVideoStream
{
    public required int Index { get; init; }
    public required string Codec { get; init; }
    public string? Profile { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public string? PixelFormat { get; init; }
    public int BitDepth { get; init; } = 8;
    public double? FrameRate { get; init; }
    public long? BitRate { get; init; }
    public string? ColorTransfer { get; init; }
    public string? ColorPrimaries { get; init; }
    public HdrFormat Hdr { get; init; }
    public bool Interlaced { get; init; }
}

public sealed record SourceAudioStream
{
    public required int Index { get; init; }
    public required string Codec { get; init; }
    public string? Profile { get; init; }
    public int Channels { get; init; } = 2;
    public string? ChannelLayout { get; init; }
    public int? SampleRate { get; init; }
    public long? BitRate { get; init; }
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool IsDefault { get; init; }
}

public sealed record SourceMediaInfo
{
    public double DurationSeconds { get; init; }
    public long? BitRate { get; init; }
    public string? Container { get; init; }
    public SourceVideoStream? Video { get; init; }
    public IReadOnlyList<SourceAudioStream> Audio { get; init; } = [];
    public int SubtitleCount { get; init; }

    public long? EstimatedVideoBitRate
        => Video?.BitRate ?? (BitRate is { } total ? Math.Max(0, total - Audio.Sum(a => a.BitRate ?? 0)) : null);
}

/// <summary>Where a transcode reads its bytes from: a live stream capability over loopback HTTP or a local sample file.</summary>
public sealed record TranscodeSource(string Kind, string Input, bool IsNetwork, string DisplayName)
{
    public const string StreamKind = "stream";
    public const string SampleKind = "sample";
}

/// <summary>Full ffprobe of a transcode source; separate from the resolve-time probe so the stream path stays untouched.</summary>
public sealed class SourceMediaProber(
    IProcessRunner runner,
    IOptions<TranscodingOptions> options,
    ILogger<SourceMediaProber> logger)
{
    public async Task<SourceMediaInfo?> ProbeAsync(TranscodeSource source, CancellationToken ct)
    {
        var o = options.Value;
        var args = new List<string>
        {
            "-v", "error",
            "-probesize", "20000000",
            "-analyzeduration", "10000000",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        };
        if (source.IsNetwork)
            args.AddRange(["-user_agent", FfmpegArgumentBuilder.UserAgent]);
        args.Add(source.Input);

        var result = await runner.RunAsync(o.FfprobePath, args, TimeSpan.FromSeconds(o.ProbeTimeoutSeconds), ct);
        if (!result.Succeeded)
        {
            logger.LogWarning(
                "Transcode source probe failed (exit {ExitCode}, timeout {TimedOut}): {Error}",
                result.ExitCode, result.TimedOut, TranscodeRedaction.Tail(result.StandardError, 5));
            return null;
        }

        try
        {
            return Parse(result.StandardOutput);
        }
        catch (JsonException e)
        {
            logger.LogWarning(e, "Transcode source probe returned malformed JSON");
            return null;
        }
    }

    internal static SourceMediaInfo Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        double duration = 0;
        long? bitRate = null;
        string? container = null;
        if (root.TryGetProperty("format", out var format))
        {
            duration = ParseDouble(Str(format, "duration")) ?? 0;
            bitRate = ParseLong(Str(format, "bit_rate"));
            container = Str(format, "format_name");
        }

        SourceVideoStream? video = null;
        var audio = new List<SourceAudioStream>();
        var subtitles = 0;
        if (root.TryGetProperty("streams", out var streams) && streams.ValueKind == JsonValueKind.Array)
        {
            foreach (var stream in streams.EnumerateArray().Take(128))
            {
                var index = stream.TryGetProperty("index", out var i) && i.TryGetInt32(out var parsed) ? parsed : -1;
                if (index < 0)
                    continue;
                switch (Str(stream, "codec_type"))
                {
                    case "video" when video is null && !IsAttachedPicture(stream):
                        video = ParseVideo(stream, index);
                        break;
                    case "audio":
                        audio.Add(new SourceAudioStream
                        {
                            Index = index,
                            Codec = Str(stream, "codec_name") ?? "unknown",
                            Profile = Str(stream, "profile"),
                            Channels = Int(stream, "channels") ?? 2,
                            ChannelLayout = Str(stream, "channel_layout"),
                            SampleRate = ParseInt(Str(stream, "sample_rate")),
                            BitRate = ParseLong(Str(stream, "bit_rate")),
                            Language = Tag(stream, "language"),
                            Title = Tag(stream, "title"),
                            IsDefault = Disposition(stream, "default"),
                        });
                        break;
                    case "subtitle":
                        subtitles++;
                        break;
                }
            }
        }

        if (duration <= 0 && root.TryGetProperty("streams", out var s2))
        {
            foreach (var stream in s2.EnumerateArray())
            {
                if (ParseDouble(Str(stream, "duration")) is { } d && d > 0)
                    duration = Math.Max(duration, d);
            }
        }

        return new SourceMediaInfo
        {
            DurationSeconds = duration,
            BitRate = bitRate,
            Container = container,
            Video = video,
            Audio = audio,
            SubtitleCount = subtitles,
        };
    }

    private static SourceVideoStream ParseVideo(JsonElement stream, int index)
    {
        var pixelFormat = Str(stream, "pix_fmt");
        var bitDepth = ParseInt(Str(stream, "bits_per_raw_sample")) is { } raw && raw > 0 ? raw : BitDepthOf(pixelFormat);
        var transfer = Str(stream, "color_transfer");
        var hdr = transfer switch
        {
            "smpte2084" => HdrFormat.Hdr10,
            "arib-std-b67" => HdrFormat.Hlg,
            _ => HdrFormat.None,
        };
        if (stream.TryGetProperty("side_data_list", out var sideData) && sideData.ValueKind == JsonValueKind.Array
            && sideData.EnumerateArray().Any(e => Str(e, "side_data_type")?.Contains("DOVI", StringComparison.OrdinalIgnoreCase) == true))
        {
            hdr = HdrFormat.DolbyVision;
        }

        var fieldOrder = Str(stream, "field_order");
        return new SourceVideoStream
        {
            Index = index,
            Codec = Str(stream, "codec_name") ?? "unknown",
            Profile = Str(stream, "profile"),
            Width = Int(stream, "width") ?? 0,
            Height = Int(stream, "height") ?? 0,
            PixelFormat = pixelFormat,
            BitDepth = bitDepth,
            FrameRate = ParseRate(Str(stream, "avg_frame_rate")) ?? ParseRate(Str(stream, "r_frame_rate")),
            BitRate = ParseLong(Str(stream, "bit_rate")),
            ColorTransfer = transfer,
            ColorPrimaries = Str(stream, "color_primaries"),
            Hdr = hdr,
            Interlaced = fieldOrder is "tt" or "bb" or "tb" or "bt",
        };
    }

    internal static int BitDepthOf(string? pixelFormat)
    {
        if (string.IsNullOrEmpty(pixelFormat))
            return 8;
        if (pixelFormat.Contains("12", StringComparison.Ordinal))
            return 12;
        return pixelFormat.Contains("10", StringComparison.Ordinal) || pixelFormat.StartsWith("p010", StringComparison.Ordinal) ? 10 : 8;
    }

    internal static double? ParseRate(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return null;
        var parts = value.Split('/');
        if (parts.Length == 2 && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
            && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d > 0 && n > 0)
        {
            var rate = n / d;
            return rate is > 0 and < 1000 ? rate : null;
        }
        return ParseDouble(value) is { } single && single is > 0 and < 1000 ? single : null;
    }

    private static bool IsAttachedPicture(JsonElement stream) => Disposition(stream, "attached_pic");

    private static bool Disposition(JsonElement stream, string name)
        => stream.TryGetProperty("disposition", out var d) && d.ValueKind == JsonValueKind.Object
           && d.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n != 0;

    private static string? Tag(JsonElement stream, string name)
        => stream.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Object ? Bounded(Str(tags, name), 128) : null;

    private static string? Str(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static int? Int(JsonElement element, string name)
        => element.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

    private static string? Bounded(string? value, int max)
        => value is { Length: > 0 } && value.Length <= max && !value.Any(char.IsControl) ? value : null;

    private static double? ParseDouble(string? value)
        => double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d) ? d : null;

    private static long? ParseLong(string? value)
        => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) && l > 0 ? l : null;

    private static int? ParseInt(string? value)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? i : null;
}
