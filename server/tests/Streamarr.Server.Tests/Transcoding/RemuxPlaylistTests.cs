using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class RemuxPlaylistTests
{
    [Fact]
    public void RegularGops_GiveSixSecondSegmentsOnTheKeyframes()
    {
        var keyframes = Enumerable.Range(0, 90).Select(i => i * 2 + 0.005).ToList();

        var timeline = SegmentTimeline.FromKeyframes(keyframes, 180, 6);

        Assert.Equal(30, timeline.Count);
        Assert.Equal(0, timeline.StartOf(0));
        Assert.Equal(6.005, timeline.StartOf(1), 6);
        Assert.Equal(174.005, timeline.StartOf(29), 6);
        Assert.Equal(6.005, timeline.Durations[0], 6);
        Assert.All(timeline.Durations.Skip(1).SkipLast(1), d => Assert.Equal(6, d, 6));
        Assert.Equal(5.995, timeline.Durations[^1], 6);
        Assert.Equal(180, timeline.Durations.Sum(), 6);
    }

    [Fact]
    public void EachTargetMovesToTheFirstKeyframeAtOrAfterIt_AndLongGopsMerge()
    {
        double[] keyframes = [0, 13, 15, 17, 19, 21.5, 23.9, 24, 31, 37.2, 39];

        var timeline = SegmentTimeline.FromKeyframes(keyframes, 41, 6);

        Assert.Equal([0, 13, 19, 24, 31, 37.2], timeline.Starts);
        Assert.Equal([13, 6, 5, 7, 6.2, 3.8], timeline.Durations.Select(d => Math.Round(d, 6)));
    }

    [Fact]
    public void ATailShorterThanASecond_JoinsTheLastSegment()
    {
        var timeline = SegmentTimeline.FromKeyframes([0, 6, 12, 18], 18.6, 6);

        Assert.Equal([0, 6, 12], timeline.Starts);
        Assert.Equal(6.6, timeline.Durations[^1], 6);
    }

    [Fact]
    public void NoUsableKeyframes_GiveOneSegment_AndIndexAtClamps()
    {
        var single = SegmentTimeline.FromKeyframes([0], 5, 6);
        var timeline = SegmentTimeline.FromKeyframes([0, 6, 12], 20, 6);

        Assert.Equal([5d], single.Durations);
        Assert.Equal(0, timeline.IndexAt(-3));
        Assert.Equal(0, timeline.IndexAt(5.999));
        Assert.Equal(1, timeline.IndexAt(6));
        Assert.Equal(2, timeline.IndexAt(19.9));
        Assert.Equal(2, timeline.IndexAt(400));
        Assert.Equal(12, timeline.EndOf(1), 6);
        Assert.Equal(2, SegmentTimeline.Create(30, 4).IndexAt(8.5));
    }

    [Fact]
    public void MediaPlaylist_UsesRealDurations_AndTheRoundedMaximumAsTargetDuration()
    {
        var timeline = SegmentTimeline.FromKeyframes([0, 6.5, 13.042, 19], 25, 6);

        var playlist = HlsPlaylist.Media(timeline);
        var subtitles = HlsPlaylist.Subtitles(timeline);

        Assert.Contains("#EXT-X-TARGETDURATION:7\n", playlist);
        Assert.Contains("#EXT-X-TARGETDURATION:8\n", HlsPlaylist.Media(SegmentTimeline.FromKeyframes([0, 8.005, 13], 20, 6)));
        Assert.Contains("#EXT-X-TARGETDURATION:9\n", HlsPlaylist.Media(SegmentTimeline.FromKeyframes([0, 8.5, 13], 20, 6)));
        Assert.Contains("#EXTINF:6.500000,\n0.m4s\n#EXTINF:6.542000,\n1.m4s\n#EXTINF:5.958000,\n2.m4s\n#EXTINF:6.000000,\n3.m4s\n", playlist);
        Assert.Contains("#EXT-X-MAP:URI=\"init.mp4\"", playlist);
        Assert.EndsWith("#EXT-X-ENDLIST\n", playlist);
        Assert.Contains("#EXTINF:6.542000,\n1.vtt\n", subtitles);
        Assert.DoesNotContain("EXT-X-MAP", subtitles);
        Assert.Contains("#EXT-X-PLAYLIST-TYPE:VOD", subtitles);
    }

    [Fact]
    public void RemuxMaster_SignalsRangeCodecsBandwidthAndSubtitleRenditions()
    {
        var media = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, audioCodec: "eac3", subtitles:
        [
            Subtitle(2, "subrip", "eng", title: "English"),
            Subtitle(3, "subrip", "ger", forced: true),
            Subtitle(4, "hdmv_pgs_subtitle", "fre"),
        ]);
        var client = new ClientProfile
        {
            VideoCodecs = ["hevc"], AudioCodecs = ["eac3"], Containers = ["mp4"], MaxAudioChannels = 6, Supports10Bit = true, HdrFormats = ["hdr10"],
        };
        var plan = Decide(media, client, allowDirect: false) with { PeakBandwidthBitsPerSecond = 28_000_000, AverageBandwidthBitsPerSecond = 16_000_000 };

        var master = HlsPlaylist.Master(plan);

        Assert.Contains("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI=\"subtitles/2/main.m3u8\"\n", master);
        Assert.Contains("NAME=\"German (forced)\",LANGUAGE=\"de\",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES,URI=\"subtitles/3/main.m3u8\"", master);
        Assert.DoesNotContain("subtitles/4/", master);
        Assert.Contains("#EXT-X-STREAM-INF:BANDWIDTH=28000000,AVERAGE-BANDWIDTH=16000000,CODECS=\"hvc1.2.4.L120.B0,ec-3\",RESOLUTION=3840x2160,", master);
        Assert.Contains("VIDEO-RANGE=PQ,SUBTITLES=\"subs\",CLOSED-CAPTIONS=NONE\nmain.m3u8\n", master);
    }

    [Fact]
    public void TranscodeMaster_IsUnchanged()
    {
        var plan = Plan(Media(subtitles: [Subtitle(2, "subrip")]));

        Assert.Equal(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n" +
            $"#EXT-X-STREAM-INF:BANDWIDTH={plan.BandwidthBitsPerSecond},AVERAGE-BANDWIDTH={plan.BandwidthBitsPerSecond},CODECS=\"avc1.640029,mp4a.40.2\"," +
            "RESOLUTION=1920x1080,FRAME-RATE=23.976,VIDEO-RANGE=SDR\nmain.m3u8\n",
            HlsPlaylist.Master(plan));
    }

    [Fact]
    public void FinalizeRemux_UsesKeyframeByteOffsetsForBandwidth_AndTheConfigRecordForCodecs()
    {
        var media = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, duration: 18, audioCodec: "eac3") with { StartTime = -0.005 };
        var client = new ClientProfile
        {
            VideoCodecs = ["hevc"], AudioCodecs = ["eac3"], Containers = ["mp4"], MaxAudioChannels = 6, Supports10Bit = true, HdrFormats = ["hdr10"],
        };
        var container = new ContainerIndex(
            KeyframeIndexSource.MatroskaCues, [0, 3, 6, 9, 12, 15], [1_000, 1_500_000, 3_000_000, 6_750_000, 8_250_000, 9_000_000], true,
            new VideoCodecConfig(VideoCodecConfig.HvcC, Convert.FromHexString("01022000000090000000000096")), 11_250_000);
        var index = new KeyframeIndex(container, container.Config, 12);

        var plan = TranscodePlanner.FinalizeRemux(Decide(media, client, allowDirect: false), media, index, container.TotalBytes);

        Assert.Equal([0, 6.005, 12.005], plan.RemuxTimeline!.Starts);
        Assert.Equal("hvc1.2.4.L150.90,ec-3", plan.CodecsAttribute);
        Assert.Equal((int)Math.Ceiling((8_250_000 - 3_000_000) * 8 / 6d * 1.1), plan.PeakBandwidthBitsPerSecond);
        Assert.Equal((int)Math.Ceiling((11_250_000 - 1_000) * 8 / 18d), plan.AverageBandwidthBitsPerSecond);
    }

    [Fact]
    public void FinalizeRemux_Bandwidth_SwapsUndeliveredConstantRateAudioForTheDeliveredAudio()
    {
        var single = Media(duration: 18, audioCodec: "ac3");
        var german = single.Audio[0] with { BitRate = 640_000, Language = "ger", IsDefault = true };
        var dual = single with { Audio = [german, german with { Index = 2, Language = "eng", IsDefault = false }] };
        var container = new ContainerIndex(KeyframeIndexSource.MatroskaCues, [0, 6, 12], [0, 6_000_000, 12_000_000], true, null, 18_000_000);
        var index = new KeyframeIndex(container, null, 1);
        var ac3Client = new ClientProfile { VideoCodecs = ["h264"], AudioCodecs = ["aac", "ac3"], Containers = ["mp4"], MaxAudioChannels = 6 };

        var copied = TranscodePlanner.FinalizeRemux(Decide(dual, ac3Client, allowDirect: false), dual, index, container.TotalBytes);
        var converted = TranscodePlanner.FinalizeRemux(Decide(dual, ClientProfile.Default, allowDirect: false), dual, index, container.TotalBytes);
        var unknownRate = TranscodePlanner.FinalizeRemux(Decide(single, ClientProfile.Default, allowDirect: false), single, index, container.TotalBytes);

        const double Bytes = 6_000_000 * 8 / 6d;
        Assert.Equal((int)Math.Ceiling((Bytes - 640_000) * 1.1), copied.PeakBandwidthBitsPerSecond);
        Assert.Equal((int)Math.Ceiling(Bytes - 640_000), copied.AverageBandwidthBitsPerSecond);
        Assert.Equal((int)Math.Ceiling((Bytes - 1_280_000 + converted.Audio!.BitrateKbps * 1000) * 1.1), converted.PeakBandwidthBitsPerSecond);
        Assert.Equal((int)Math.Ceiling((Bytes + unknownRate.Audio!.BitrateKbps * 1000) * 1.1), unknownRate.PeakBandwidthBitsPerSecond);
    }
}

public sealed class WebVttTests
{
    [Fact]
    public void ParseCues_ReadsIdsSettingsHoursAndMultiLineText()
    {
        var cues = WebVttSubtitles.ParseCues("WEBVTT\n\nintro\n00:01.500 --> 00:04.000 line:90%\n<i>Hello</i>\nWorld\n\n01:02:03.004 --> 01:02:05.000\nLate\n\nbroken --> nope\nx\n\n00:09.000 --> 00:08.000\nbackwards\n").ToList();

        Assert.Equal(2, cues.Count);
        Assert.Equal(new WebVttCue(1.5, 4, "line:90%", "<i>Hello</i>\nWorld"), cues[0]);
        Assert.Equal(3723.004, cues[1].Start, 6);
        Assert.Equal("Late", cues[1].Text);
    }

    [Fact]
    public void Store_ReadsOnlyCompleteBlocks_DedupsAcrossRuns_AndReturnsOverlaps()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-vtt-").FullName;
        try
        {
            var store = new SubtitleTrackStore(3);
            var run1 = Path.Combine(directory, store.FileName("1"));
            File.WriteAllText(run1, "WEBVTT\n\n00:02.000 --> 00:05.000\nOne\n\n00:05.500 --> 00:07.000\nTw");
            store.Refresh(directory);
            Assert.Single(store.Between(0, 100));

            File.AppendAllText(run1, "o\n\n");
            File.WriteAllText(Path.Combine(directory, store.FileName("2")), "WEBVTT\n\n00:05.500 --> 00:07.000\nTwo\n\n00:12.000 --> 00:13.000\nThree\n");
            File.WriteAllText(Path.Combine(directory, "sub-4-1.vtt"), "WEBVTT\n\n00:01.000 --> 00:02.000\nOther stream\n\n");
            store.Refresh(directory);

            Assert.Equal(["One", "Two", "Three"], store.Between(0, 100).Select(c => c.Text));
            File.AppendAllText(Path.Combine(directory, store.FileName("2")), "\n00:20.000 --> 00:21.000\nFour\nlines\n");
            store.Refresh(directory);
            Assert.Equal(["Three", "Four\nlines"], store.Between(11, 30).Select(c => c.Text));
            Assert.Equal(["One", "Two"], store.Between(4.9, 6).Select(c => c.Text));
            Assert.Empty(store.Between(7, 12));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void Segment_MapsLocalZeroToMpegTsZero_AndWritesFullTimestamps()
    {
        var segment = WebVttSubtitles.Segment([new WebVttCue(62.005, 3666.5, "align:start", "<b>Hi</b>")]);

        Assert.Equal("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:01:02.005 --> 01:01:06.500 align:start\n<b>Hi</b>\n", segment);
        Assert.Equal("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n", WebVttSubtitles.Segment([]));
    }

    [Theory]
    [InlineData("eng", "en", "English")]
    [InlineData("ger", "de", "German")]
    [InlineData("deu", "de", "German")]
    [InlineData("pt", "pt", "pt")]
    [InlineData("tlh", "tlh", "tlh")]
    [InlineData("und", null, null)]
    [InlineData("x-1", null, null)]
    [InlineData(null, null, null)]
    public void Languages_MapToRfc5646(string? iso, string? bcp47, string? name)
    {
        Assert.Equal(bcp47, WebVttSubtitles.Bcp47(iso));
        Assert.Equal(name, WebVttSubtitles.LanguageName(iso));
    }
}
