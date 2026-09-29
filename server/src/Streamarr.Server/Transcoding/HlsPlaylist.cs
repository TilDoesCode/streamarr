using System.Globalization;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Segment timeline computed up front, so players can seek before anything was produced: a fixed grid (transcode) or keyframe-aligned (remux).</summary>
public sealed record SegmentTimeline
{
    private const double TinyTailSeconds = 0.5;
    private const double MinRemuxTailSeconds = 1.0;

    public SegmentTimeline(double segmentLength, IReadOnlyList<double> durations, IReadOnlyList<double>? starts = null)
    {
        SegmentLength = segmentLength;
        Durations = durations;
        Starts = starts ?? Enumerable.Range(0, durations.Count).Select(i => i * segmentLength).ToList();
    }

    /// <summary>Nominal (fixed grid) or target (keyframe-aligned) segment length.</summary>
    public double SegmentLength { get; }
    public IReadOnlyList<double> Durations { get; }
    public IReadOnlyList<double> Starts { get; }

    public int Count => Durations.Count;

    public double StartOf(int index) => Starts[index];

    public double EndOf(int index) => Starts[index] + Durations[index];

    public double MaxDuration => Durations.Max();

    /// <summary>Index of the segment containing <paramref name="seconds"/> (clamped to the timeline).</summary>
    public int IndexAt(double seconds)
    {
        var index = 0;
        var high = Count - 1;
        while (index < high)
        {
            var mid = (index + high + 1) / 2;
            if (Starts[mid] <= seconds + 1e-9)
                index = mid;
            else
                high = mid - 1;
        }
        return index;
    }

    public static SegmentTimeline Create(double durationSeconds, double segmentLength)
    {
        if (durationSeconds <= 0 || segmentLength <= 0)
            throw new ArgumentOutOfRangeException(nameof(durationSeconds));
        var full = (int)Math.Floor(durationSeconds / segmentLength);
        var tail = durationSeconds - full * segmentLength;
        var durations = Enumerable.Repeat(segmentLength, full).ToList();
        if (tail >= TinyTailSeconds || durations.Count == 0)
            durations.Add(Math.Round(tail, 6));
        return new SegmentTimeline(segmentLength, durations);
    }

    /// <summary>Stream-copy plan: each boundary n × <paramref name="target"/> moves to the first keyframe at or after it; shared keyframes merge, a tail under 1 s joins the last segment.</summary>
    public static SegmentTimeline FromKeyframes(IReadOnlyList<double> keyframes, double durationSeconds, double target)
    {
        if (durationSeconds <= 0 || target <= 0)
            throw new ArgumentOutOfRangeException(nameof(durationSeconds));
        var starts = new List<double> { 0 };
        var next = target;
        foreach (var keyframe in keyframes.Order())
        {
            if (keyframe <= starts[^1] + 1e-6 || keyframe < next - 1e-6)
                continue;
            if (durationSeconds - keyframe < MinRemuxTailSeconds)
                break;
            starts.Add(Math.Round(keyframe, 6));
            while (next <= keyframe + 1e-6)
                next += target;
        }
        var durations = starts.Select((start, i) => Math.Round((i + 1 < starts.Count ? starts[i + 1] : durationSeconds) - start, 6)).ToList();
        return new SegmentTimeline(target, durations, starts);
    }
}

public static class HlsPlaylist
{
    public const string MediaPlaylistName = "main.m3u8";
    public const string InitSegmentName = "init.mp4";
    public const string SubtitleGroup = "subs";

    public static string Master(TranscodePlan plan)
    {
        var video = plan.Video;
        var remux = plan.Mode == DeliveryMode.Remux;
        var subtitles = remux ? plan.Subtitles.Where(s => s.Delivered).ToList() : [];
        var bandwidth = plan.PeakBandwidthBitsPerSecond ?? plan.BandwidthBitsPerSecond;
        var average = plan.AverageBandwidthBitsPerSecond ?? plan.BandwidthBitsPerSecond;
        var builder = new StringBuilder()
            .Append("#EXTM3U\n")
            .Append("#EXT-X-VERSION:7\n")
            .Append("#EXT-X-INDEPENDENT-SEGMENTS\n");
        foreach (var subtitle in subtitles)
        {
            builder.Append(CultureInfo.InvariantCulture, $"#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"{SubtitleGroup}\",NAME=\"{subtitle.Name}\",");
            if (subtitle.Language is { } language)
                builder.Append(CultureInfo.InvariantCulture, $"LANGUAGE=\"{language}\",");
            builder.Append(CultureInfo.InvariantCulture,
                $"DEFAULT=NO,AUTOSELECT=YES,FORCED={(subtitle.Stream.IsForced ? "YES" : "NO")},URI=\"{SubtitlePlaylistPath(subtitle.Stream.Index)}\"\n");
        }
        builder
            .Append(CultureInfo.InvariantCulture, $"#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={average},")
            .Append(CultureInfo.InvariantCulture, $"CODECS=\"{plan.CodecsAttribute}\",")
            .Append(CultureInfo.InvariantCulture, $"RESOLUTION={video.Width}x{video.Height},")
            .Append(CultureInfo.InvariantCulture, $"FRAME-RATE={video.FrameRate:0.000},VIDEO-RANGE={(remux ? plan.VideoRange : "SDR")}");
        if (subtitles.Count > 0)
            builder.Append(CultureInfo.InvariantCulture, $",SUBTITLES=\"{SubtitleGroup}\"");
        if (remux)
            builder.Append(",CLOSED-CAPTIONS=NONE");
        return builder.Append('\n').Append(MediaPlaylistName).Append('\n').ToString();
    }

    public static string SubtitlePlaylistPath(int streamIndex)
        => string.Create(CultureInfo.InvariantCulture, $"subtitles/{streamIndex}/{MediaPlaylistName}");

    public static string Media(SegmentTimeline timeline) => Playlist(timeline, $"#EXT-X-MAP:URI=\"{InitSegmentName}\"\n", "m4s");

    public static string Subtitles(SegmentTimeline timeline) => Playlist(timeline, string.Empty, "vtt");

    private static string Playlist(SegmentTimeline timeline, string map, string extension)
    {
        // RFC 8216: every EXTINF rounded to the nearest integer must not exceed the target duration.
        var target = Math.Max(1, (int)Math.Round(timeline.Durations.Max(), MidpointRounding.AwayFromZero));
        var builder = new StringBuilder()
            .Append("#EXTM3U\n")
            .Append("#EXT-X-VERSION:7\n")
            .Append(CultureInfo.InvariantCulture, $"#EXT-X-TARGETDURATION:{target}\n")
            .Append("#EXT-X-MEDIA-SEQUENCE:0\n")
            .Append("#EXT-X-PLAYLIST-TYPE:VOD\n");
        if (map.Length > 0)
            builder.Append("#EXT-X-INDEPENDENT-SEGMENTS\n").Append(map);
        for (var i = 0; i < timeline.Count; i++)
        {
            builder.Append(CultureInfo.InvariantCulture, $"#EXTINF:{timeline.Durations[i]:0.000000},\n")
                .Append(CultureInfo.InvariantCulture, $"{i}.{extension}\n");
        }
        return builder.Append("#EXT-X-ENDLIST\n").ToString();
    }
}
