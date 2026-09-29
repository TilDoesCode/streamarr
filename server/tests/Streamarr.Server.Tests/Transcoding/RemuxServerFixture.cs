using System.Text;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>The transcoding server plus remux media: H.264/E-AC-3/SRT/ASS with irregular keyframes (MKV, MP4, no Cues) and open-GOP HEVC HDR10.</summary>
public sealed class RemuxServerFixture : TranscodingServerFixture
{
    public const string RemuxWorkId = "tmdb-movie-4343";
    public const string H264Mkv = "rel-remux-h264-mkv";
    public const string H264Mp4 = "rel-remux-h264-mp4";
    public const string NoCuesMkv = "rel-remux-nocues-mkv";
    public const string HevcHdr = "rel-remux-hevc-hdr10";
    public const int H264Seconds = 90;
    public const int HevcSeconds = 30;

    /// <summary>Forced keyframes of the H.264 source; the remux plan must cut at 0, 8, 13, 20, 27, 33, 40, … 88.</summary>
    public static readonly double[] Keyframes = [0, 2.5, 5, 8, 13, 14, 20, 21.5, 27, 33, 40, 46, 52, 58, 64, 70, 76, 82, 88];

    protected override async Task<IReadOnlyList<FixtureRelease>> GenerateExtraReleasesAsync(string directory)
    {
        var srt = Path.Combine(directory, "en.srt");
        var ass = Path.Combine(directory, "de.ass");
        await File.WriteAllTextAsync(srt, Srt());
        await File.WriteAllTextAsync(ass, Ass());
        var mkv = Path.Combine(directory, "remux.mkv");
        var mp4 = Path.Combine(directory, "remux.mp4");
        var noCues = Path.Combine(directory, "nocues.mkv");
        var hevc = Path.Combine(directory, "hdr10.mkv");
        const string Surround = "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0";

        await KeyframeFixture.FfmpegAsync(
            "-f", "lavfi", "-i", $"testsrc2=size=640x360:rate=24:duration={H264Seconds}",
            "-f", "lavfi", "-i", $"sine=frequency=330:beep_factor=4:sample_rate=48000:duration={H264Seconds}",
            "-i", srt, "-i", ass,
            "-filter_complex", $"[1:a]{Surround}[a]", "-map", "0:v", "-map", "[a]", "-map", "2", "-map", "3",
            "-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-b:v", "300k", "-pix_fmt", "yuv420p",
            "-x264-params", "keyint=5000:min-keyint=5000:scenecut=0",
            "-force_key_frames", string.Join(',', Keyframes.Select(k => k.ToString(System.Globalization.CultureInfo.InvariantCulture))),
            "-c:a", "eac3", "-b:a", "192k", "-c:s:0", "srt", "-c:s:1", "ass",
            "-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English",
            "-metadata:s:s:1", "language=ger", "-metadata:s:s:1", "title=Deutsch", mkv);
        await KeyframeFixture.FfmpegAsync("-i", mkv, "-map", "0:v", "-map", "0:a", "-c", "copy", mp4);
        await File.WriteAllBytesAsync(noCues, WithoutCuesPointer(await File.ReadAllBytesAsync(mkv)));
        await KeyframeFixture.FfmpegAsync(
            "-f", "lavfi", "-i", $"testsrc2=size=640x360:rate=24:duration={HevcSeconds}",
            "-f", "lavfi", "-i", $"sine=frequency=550:sample_rate=48000:duration={HevcSeconds}",
            "-filter_complex", $"[1:a]{Surround}[a]", "-map", "0:v", "-map", "[a]",
            "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
            "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
            "-x265-params", "keyint=48:min-keyint=48:scenecut=0:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:" +
                            "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400:log-level=error",
            "-c:a", "ac3", "-b:a", "384k", hevc);

        return
        [
            new(H264Mkv, RemuxWorkId, "Remux.Source.2024.1080p.WEB-DL.DDP5.1.H.264.mkv", await File.ReadAllBytesAsync(mkv)),
            new(H264Mp4, RemuxWorkId, "Remux.Source.2024.1080p.WEB-DL.DDP5.1.H.264.mp4", await File.ReadAllBytesAsync(mp4)),
            new(NoCuesMkv, RemuxWorkId, "Remux.Source.2024.1080p.WEB-DL.DDP5.1.H.264-NOCUES.mkv", await File.ReadAllBytesAsync(noCues)),
            new(HevcHdr, RemuxWorkId, "Remux.Source.2024.2160p.UHD.BluRay.DD5.1.HDR10.x265.mkv", await File.ReadAllBytesAsync(hevc)),
        ];
    }

    /// <summary>Renames the SeekHead's Cues entry to an unknown element id, as muxers that write no seek entry for Cues leave it.</summary>
    private static byte[] WithoutCuesPointer(byte[] mkv)
    {
        byte[] entry = [0x53, 0xAB, 0x84, 0x1C, 0x53, 0xBB, 0x6B];
        var at = mkv.AsSpan(0, 4096).IndexOf(entry);
        Assert.True(at > 0, "the SeekHead lists Cues");
        mkv[at + 6] = 0x6C;
        return mkv;
    }

    /// <summary>"EN n" every 10 s, plus one cue that spans the 13 s segment boundary.</summary>
    private static string Srt()
    {
        var builder = new StringBuilder();
        var n = 1;
        foreach (var (start, end, text) in Enumerable.Range(0, 9).Select(i => (i * 10 + 2d, i * 10 + 5d, $"EN {i + 1}")).Append((12.5, 14.5, "EN spanning")).OrderBy(c => c.Item1))
            builder.Append($"{n++}\n{Time(start, ',')} --> {Time(end, ',')}\n{text}\n\n");
        return builder.ToString();
    }

    private static string Ass()
    {
        var builder = new StringBuilder("[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\n" +
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
            "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\n" +
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
        for (var i = 0; i < 9; i++)
            builder.Append($"Dialogue: 0,{Time(i * 10 + 6, '.', ass: true)},{Time(i * 10 + 8, '.', ass: true)},Default,,0,0,0,,{{\\i1}}DE {i + 1}{{\\i0}}\n");
        return builder.ToString();
    }

    private static string Time(double seconds, char separator, bool ass = false)
    {
        var t = TimeSpan.FromSeconds(seconds);
        return ass
            ? $"{t.Hours}:{t.Minutes:00}:{t.Seconds:00}.{t.Milliseconds / 10:00}"
            : $"{t.Hours:00}:{t.Minutes:00}:{t.Seconds:00}{separator}{t.Milliseconds:000}";
    }
}

[CollectionDefinition("remux-server", DisableParallelization = true)]
public class RemuxServerCollection : ICollectionFixture<RemuxServerFixture>;
