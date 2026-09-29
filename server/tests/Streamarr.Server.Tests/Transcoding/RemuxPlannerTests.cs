using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class RemuxPlannerTests
{
    private static readonly ClientProfile Browser = ClientProfile.Default;

    private static readonly ClientProfile AppleTv = new()
    {
        VideoCodecs = ["h264", "hevc"],
        AudioCodecs = ["aac", "ac3", "eac3"],
        Containers = ["mp4"],
        MaxAudioChannels = 6,
        Supports10Bit = true,
        HdrFormats = ["hdr10", "hlg"],
    };

    private static IEnumerable<string> Codes(IEnumerable<PlanReason> reasons) => reasons.Select(r => r.Code);

    [Fact]
    public void MkvWithAc3_ForABrowser_IsRemuxedWithAacStereo_AndExplainsWhy()
    {
        var plan = Decide(Media(container: "matroska,webm", audioCodec: "ac3", channels: 6), Browser, allowDirect: false);

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.Equal(["container_unsupported", "audio_codec_unsupported", "audio_converted"], Codes(plan.Reasons));
        Assert.Equal("copy", plan.Encoder);
        Assert.Equal(("aac", 2, false), (plan.Audio!.Codec, plan.Audio.Channels, plan.Audio.Copy));
        Assert.Equal("mp4a.40.2", plan.Audio.CodecsTag);
        Assert.Equal((1920, 1080), (plan.Video.Width, plan.Video.Height));
        Assert.Equal("SDR", plan.VideoRange);
        Assert.False(plan.HardwareDecode);
        Assert.Equal(ToneMapMode.NotNeeded, plan.ToneMap);
        Assert.Equal("ac3", plan.Reasons[2].Params!["from"]);
    }

    [Theory]
    [InlineData("eac3", 6, new[] { "aac", "eac3" }, 6, "eac3", true, 6)]
    [InlineData("eac3", 6, new[] { "aac", "ac3" }, 6, "ac3", false, 6)]
    [InlineData("truehd", 6, new[] { "aac", "ac3", "eac3" }, 6, "eac3", false, 6)]
    [InlineData("dts", 6, new[] { "aac", "ac3" }, 6, "ac3", false, 6)]
    [InlineData("truehd", 8, new[] { "aac", "eac3" }, 2, "aac", false, 2)]
    [InlineData("eac3", 6, new[] { "eac3" }, 2, "aac", false, 2)]
    [InlineData("ac3", 2, new[] { "ac3" }, 2, "ac3", true, 2)]
    [InlineData("opus", 6, new[] { "opus", "aac" }, 6, "opus", true, 6)]
    [InlineData("flac", 2, new[] { "aac" }, 2, "aac", false, 2)]
    [InlineData("dts", 1, new[] { "aac" }, 2, "aac", false, 1)]
    public void AudioLadder_CopiesWhatThePlayerTakes_ElseEac3ThenAc3ThenAacStereo(
        string source, int channels, string[] clientCodecs, int maxChannels, string expected, bool copy, int expectedChannels)
    {
        var client = Browser with { AudioCodecs = clientCodecs, MaxAudioChannels = maxChannels };

        var plan = Decide(Media(audioCodec: source, channels: channels), client, allowDirect: false);

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.Equal((expected, copy, expectedChannels), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels));
        Assert.Contains(plan.Reasons, r => r.Code == (copy ? "audio_copied" : "audio_converted"));
        if (!copy && expected is "ac3" or "eac3")
            Assert.Equal(640, plan.Audio.BitrateKbps);
    }

    [Fact]
    public void Hdr10Hevc_ForAnHdrCapableClient_IsCopiedWithPqRange()
    {
        var plan = Decide(Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, audioCodec: "truehd"), AppleTv);

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.Equal("PQ", plan.VideoRange);
        Assert.Equal(("hevc", 3840, 2160), (plan.Video.Codec, plan.Video.Width, plan.Video.Height));
        Assert.Equal("eac3", plan.Audio!.Codec);
        Assert.StartsWith("hvc1.2.4.", plan.Video.CodecsTag);
    }

    [Theory]
    [InlineData(HdrFormat.Hlg, null, null, "arib-std-b67", "HLG")]
    [InlineData(HdrFormat.DolbyVision, 8, 1, "smpte2084", "PQ")]
    [InlineData(HdrFormat.DolbyVision, 8, 4, "arib-std-b67", "HLG")]
    [InlineData(HdrFormat.DolbyVision, 7, 6, "smpte2084", "PQ")]
    [InlineData(HdrFormat.None, null, null, null, "SDR")]
    public void VideoRange_FollowsTheBaseLayer(HdrFormat hdr, int? profile, int? compatibility, string? transfer, string range)
    {
        var plan = Decide(Media(codec: "hevc", bitDepth: 10, hdr: hdr, dvProfile: profile, dvCompatibility: compatibility, colorTransfer: transfer), AppleTv);

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.Equal(range, plan.VideoRange);
    }

    [Fact]
    public void DolbyVisionProfile5_HasNoPlayableBaseLayer_AndIsTranscoded()
    {
        var plan = Decide(Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.DolbyVision, dvProfile: 5, dvCompatibility: 0), AppleTv);

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.False(plan.RemuxPossible);
        var reason = Assert.Single(plan.RemuxBlockers);
        Assert.Equal(("dolby_vision_profile_unsupported", "5"), (reason.Code, reason.Params!["profile"]));
    }

    [Theory]
    [InlineData("mpeg2video", 8, false, "video_codec_not_remuxable")]
    [InlineData("vp9", 8, false, "video_codec_not_remuxable")]
    [InlineData("vc1", 8, false, "video_codec_not_remuxable")]
    [InlineData("h264", 10, false, "video_profile_unsupported")]
    [InlineData("h264", 8, true, "interlaced")]
    [InlineData("av1", 8, false, "video_codec_unsupported")]
    public void VideoTheClientCannotDecode_ForcesATranscode(string codec, int bitDepth, bool interlaced, string code)
    {
        var plan = Decide(Media(codec: codec, bitDepth: bitDepth, interlaced: interlaced), AppleTv, allowDirect: false);

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Contains(code, Codes(plan.Reasons));
        Assert.Equal("libx264", plan.Encoder);
    }

    [Fact]
    public void TenBitAndHdr_AreCheckedAgainstTheClient()
    {
        var hdr10 = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10);

        var no10Bit = Decide(hdr10, AppleTv with { Supports10Bit = false });
        var hlgOnly = Decide(hdr10, AppleTv with { HdrFormats = ["hlg"] });
        var legacyFlag = Decide(hdr10, AppleTv with { HdrFormats = null, SupportsHdr = true });

        Assert.Contains("bit_depth_unsupported", Codes(no10Bit.RemuxBlockers));
        Assert.Equal(("hdr_unsupported", "hdr10"), (hlgOnly.RemuxBlockers.Single().Code, hlgOnly.RemuxBlockers.Single().Params!["hdr"]));
        Assert.Equal(DeliveryMode.Remux, legacyFlag.Mode);
    }

    [Fact]
    public void RequestLimits_BlockACopy_ButServerTranscodeCapsDoNot()
    {
        var uhd = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, bitRate: 40_000_000);

        var limited = Decide(uhd, AppleTv, limits: new TranscodeLimits(MaxHeight: 1080));
        var capped = Decide(uhd, AppleTv, settings: new TranscodingSettings { MaxHeight = 1080, MaxBitrateKbps = 8_000 });
        var bandwidth = Decide(uhd, AppleTv, limits: new TranscodeLimits(MaxBitrateKbps: 20_000));

        Assert.Equal(DeliveryMode.Transcode, limited.Mode);
        Assert.Contains("resolution_exceeds_limit", Codes(limited.RemuxBlockers));
        Assert.Equal(DeliveryMode.Remux, capped.Mode);
        Assert.Equal(("bitrate_exceeds_limit", "40000", "20000"),
            (bandwidth.RemuxBlockers.Single().Code, bandwidth.RemuxBlockers.Single().Params!["kbps"], bandwidth.RemuxBlockers.Single().Params!["max"]));
    }

    [Fact]
    public void DirectPlay_WinsWhenAllowed_OtherwiseAnHlsRequestIsARemux()
    {
        var mp4 = Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2, bitRate: 3_000_000);

        var direct = Decide(mp4, Browser);
        var hls = Decide(mp4, Browser, allowDirect: false);
        var forced = Decide(mp4, Browser, ModePreference.Transcode);

        Assert.Equal((DeliveryMode.Direct, "direct_play"), (direct.Mode, direct.Reasons.Single().Code));
        Assert.Equal(DeliveryMode.Remux, hls.Mode);
        Assert.Equal(["hls_requested", "audio_copied"], Codes(hls.Reasons));
        Assert.True(hls.Audio!.Copy);
        Assert.Equal(DeliveryMode.Transcode, forced.Mode);
        Assert.Equal("transcode_requested", forced.Reasons[0].Code);
        Assert.True(forced.RemuxPossible);
    }

    [Fact]
    public void DirectPlay_Target_DescribesTheOriginalStreams_NotATranscode()
    {
        var mp4 = Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2, bitRate: 3_000_000);
        var hdr = mp4 with { Video = mp4.Video! with { Codec = "hevc", Profile = "Main 10", PixelFormat = "yuv420p10le", BitDepth = 10, ColorTransfer = "smpte2084", Hdr = HdrFormat.Hdr10 } };

        var direct = Decide(mp4, Browser);
        var directHdr = Decide(hdr, AppleTv);

        Assert.Equal(DeliveryMode.Direct, direct.Mode);
        Assert.Equal(("none", "h264", 1920, 1080), (direct.Encoder, direct.Video.Codec, direct.Video.Width, direct.Video.Height));
        Assert.StartsWith("avc1.", direct.Video.CodecsTag);
        Assert.Equal(("aac", true, 2), (direct.Audio!.Codec, direct.Audio.Copy, direct.Audio.Channels));
        Assert.False(direct.HardwareDecode || direct.HardwareEncode);
        Assert.Empty(direct.Warnings);
        Assert.Equal("SDR", direct.VideoRange);
        Assert.Equal((DeliveryMode.Direct, "hevc", "PQ", ToneMapMode.NotNeeded), (directHdr.Mode, directHdr.Video.Codec, directHdr.VideoRange, directHdr.ToneMap));
    }

    [Fact]
    public void Transcode_WithASelectedSubtitle_ReportsItAsNotDeliverable()
    {
        var media = Media(codec: "mpeg2video", subtitles: [Subtitle(2, "subrip", "eng"), Subtitle(3, "hdmv_pgs_subtitle", "eng")]);

        var image = Decide(media, Browser, allowDirect: false, limits: new TranscodeLimits(SubtitleStreamIndex: 3));
        var text = Decide(media, Browser, allowDirect: false, limits: new TranscodeLimits(SubtitleStreamIndex: 2));
        var none = Decide(media, Browser, allowDirect: false);

        Assert.Equal(DeliveryMode.Transcode, image.Mode);
        var reason = Assert.Single(image.Reasons, r => r.Code == "subtitle_not_deliverable");
        Assert.Equal(("3", "hdmv_pgs_subtitle", "transcode"), (reason.Params!["index"], reason.Params["codec"], reason.Params["mode"]));
        Assert.Contains("image-based", reason.Message);
        Assert.Contains(text.Reasons, r => r.Code == "subtitle_not_deliverable" && r.Params!["index"] == "2");
        Assert.DoesNotContain(none.Reasons, r => r.Code == "subtitle_not_deliverable");
    }

    [Fact]
    public void MissingKeyframeIndex_FallsBackToATranscode_WithTheReason()
    {
        var reason = PlanReason.Of("keyframe_index_unavailable", "No keyframe index.", ("detail", "gap"));

        var plan = Decide(Media(), Browser, allowDirect: false, remuxUnavailable: reason);

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.False(plan.RemuxPossible);
        Assert.Contains("keyframe_index_unavailable", Codes(plan.Reasons));
    }

    [Fact]
    public void Subtitles_TextBecomesWebVtt_ImageIsReported_AndDirectPlayKeepsThemEmbedded()
    {
        var media = Media(subtitles:
        [
            Subtitle(2, "subrip", "eng", title: "English"),
            Subtitle(3, "ass", "ger", title: "Deutsch \"styled\""),
            Subtitle(4, "subrip", "ger", forced: true),
            Subtitle(5, "hdmv_pgs_subtitle", "fre"),
            Subtitle(6, "subrip", "und"),
        ]);

        var remux = Decide(media, Browser, allowDirect: false, limits: new TranscodeLimits(SubtitleStreamIndex: 5));
        var transcode = Decide(media, Browser, ModePreference.Transcode);
        var direct = Decide(media with { Container = "mov,mp4,m4a,3gp,3g2,mj2", Audio = [media.Audio[0] with { Codec = "aac", Profile = "LC" }] }, Browser);

        Assert.Equal(["webvtt", "webvtt", "webvtt", "none", "webvtt"], remux.Subtitles.Select(s => s.DeliveredAs));
        Assert.Equal(["English", "Deutsch styled", "German (forced)", "French", "Subtitle 6"], remux.Subtitles.Select(s => s.Name));
        Assert.Equal(["en", "de", "de", "fr", null], remux.Subtitles.Select(s => s.Language));
        var image = Assert.Single(remux.Reasons, r => r.Code == "subtitle_not_deliverable");
        Assert.Equal("hdmv_pgs_subtitle", image.Params!["codec"]);
        Assert.All(transcode.Subtitles, s => Assert.Equal("none", s.DeliveredAs));
        Assert.Equal(DeliveryMode.Direct, direct.Mode);
        Assert.All(direct.Subtitles, s => Assert.Equal("embedded", s.DeliveredAs));
    }

    [Fact]
    public void SubtitleFormat_BlocksDirectPlay_OnlyWhenTheClientDeclaresFormats()
    {
        var media = Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2, subtitles: [Subtitle(2, "subrip"), Subtitle(3, "hdmv_pgs_subtitle")]);
        var limits = new TranscodeLimits(SubtitleStreamIndex: 3);

        var undeclared = Decide(media, Browser, limits: limits);
        var srtOnly = Decide(media, Browser with { SubtitleFormats = ["srt"] }, limits: limits);
        var srtAlias = Decide(media, Browser with { SubtitleFormats = ["srt"] }, limits: new TranscodeLimits(SubtitleStreamIndex: 2));

        Assert.Equal(DeliveryMode.Direct, undeclared.Mode);
        Assert.Equal(DeliveryMode.Remux, srtOnly.Mode);
        Assert.Contains("subtitle_format_unsupported", Codes(srtOnly.DirectPlayReasons));
        Assert.Equal(DeliveryMode.Direct, srtAlias.Mode);
        var error = Assert.Throws<TranscodePlanningException>(() => Decide(media, Browser, limits: new TranscodeLimits(SubtitleStreamIndex: 9)));
        Assert.Equal("unknown_subtitle_stream", error.Code);
    }

    [Theory]
    [InlineData(null, ModePreference.Auto, true)]
    [InlineData("auto", ModePreference.Auto, true)]
    [InlineData(" Remux ", ModePreference.Remux, true)]
    [InlineData("copy", ModePreference.Remux, true)]
    [InlineData("transcode", ModePreference.Transcode, true)]
    [InlineData("direct", ModePreference.Auto, false)]
    public void ModePreference_Parses(string? value, ModePreference expected, bool valid)
    {
        Assert.Equal(valid, DeliveryModeNames.TryParsePreference(value, out var parsed));
        if (valid)
            Assert.Equal(expected, parsed);
    }
}
