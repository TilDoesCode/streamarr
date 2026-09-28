using System.Globalization;
using System.Text;

namespace Streamarr.Server.Transcoding;

/// <summary>Fixed-grid segment timeline computed up front from the runtime, so players can seek before anything is transcoded.</summary>
public sealed record SegmentTimeline(double SegmentLength, IReadOnlyList<double> Durations)
{
    private const double TinyTailSeconds = 0.5;

    public int Count => Durations.Count;

    public double StartOf(int index) => index * SegmentLength;

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
}

public static class HlsPlaylist
{
    public const string MediaPlaylistName = "main.m3u8";
    public const string InitSegmentName = "init.mp4";

    public static string Master(TranscodePlan plan)
    {
        var video = plan.Video;
        var builder = new StringBuilder()
            .Append("#EXTM3U\n")
            .Append("#EXT-X-VERSION:7\n")
            .Append("#EXT-X-INDEPENDENT-SEGMENTS\n")
            .Append(CultureInfo.InvariantCulture,
                $"#EXT-X-STREAM-INF:BANDWIDTH={plan.BandwidthBitsPerSecond},AVERAGE-BANDWIDTH={plan.BandwidthBitsPerSecond},")
            .Append(CultureInfo.InvariantCulture, $"CODECS=\"{plan.CodecsAttribute}\",")
            .Append(CultureInfo.InvariantCulture, $"RESOLUTION={video.Width}x{video.Height},")
            .Append(CultureInfo.InvariantCulture, $"FRAME-RATE={video.FrameRate:0.000},VIDEO-RANGE=SDR\n")
            .Append(MediaPlaylistName).Append('\n');
        return builder.ToString();
    }

    public static string Media(SegmentTimeline timeline)
    {
        var target = Math.Max(1, (int)Math.Ceiling(timeline.Durations.Max() - 1e-6));
        var builder = new StringBuilder()
            .Append("#EXTM3U\n")
            .Append("#EXT-X-VERSION:7\n")
            .Append(CultureInfo.InvariantCulture, $"#EXT-X-TARGETDURATION:{target}\n")
            .Append("#EXT-X-MEDIA-SEQUENCE:0\n")
            .Append("#EXT-X-PLAYLIST-TYPE:VOD\n")
            .Append("#EXT-X-INDEPENDENT-SEGMENTS\n")
            .Append(CultureInfo.InvariantCulture, $"#EXT-X-MAP:URI=\"{InitSegmentName}\"\n");
        for (var i = 0; i < timeline.Count; i++)
        {
            builder.Append(CultureInfo.InvariantCulture, $"#EXTINF:{timeline.Durations[i]:0.000000},\n")
                .Append(CultureInfo.InvariantCulture, $"{i}.m4s\n");
        }
        return builder.Append("#EXT-X-ENDLIST\n").ToString();
    }
}
