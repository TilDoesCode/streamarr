using Streamarr.Core.Parser;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Device-aware "Recommended": the best quality that plays without a server transcode, from the release names.</summary>
public sealed class RecommendedVersionTests
{
    private const string Uhd = "Movie.2019.2160p.UHD.BluRay.x265.10bit.HDR10.TrueHD.7.1-GRP";
    private const string UhdSdr = "Movie.2019.2160p.WEB-DL.x265.AAC-GRP";
    private const string HdHevc = "Movie.2019.1080p.WEB-DL.x265.AAC-GRP";
    private const string Hd = "Movie.2019.1080p.WEB-DL.H264.AAC.MP4-GRP";
    private const string HdMkv = "Movie.2019.1080p.BluRay.H264.AAC-OTHER";
    private const string Mpeg2 = "Movie.2019.720p.HDTV.MPEG2.AC3-GRP";

    private static readonly PlaybackPredictor Predictor = new(null!);

    private static List<VersionDto> Order(DeviceCaps device, bool allowTranscoding, params string[] qualityOrder)
    {
        var play = new PlayContext(device, PlaybackPreferences.Default, FakePlaybackMedia.Available());
        return RankOf(qualityOrder.Select((name, i) =>
        {
            var parsed = ReleaseParser.Parse(name);
            var version = new VersionDto { ReleaseId = name, Name = name, Rank = i + 1, QualityRank = i + 1, Health = "healthy" };
            return (version, (string?)Predictor.Classify(parsed, 8000, 120, play, allowTranscoding), VersionMapper.Height(parsed.Resolution));
        }).ToList());
    }

    private static List<VersionDto> RankOf(List<(VersionDto, string?, int)> versions) => ViewerCatalogService.DeviceOrder(versions);

    [Fact]
    public void Hdr_Transcode_On_A_Non_Hdr_Web_Profile_Loses_To_1080p_Direct()
    {
        var order = Order(PlaybackDeciderTests.Chrome(hdr: false), allowTranscoding: true, Uhd, Hd);

        var recommended = Assert.Single(order, v => v.Recommended);
        Assert.Equal(Hd, recommended.ReleaseId);
        Assert.Equal((1, 2), (recommended.Rank, recommended.QualityRank));
        Assert.Equal((2, 1), (order[1].Rank, order[1].QualityRank));
    }

    [Fact]
    public void Hevc_Remux_4k_Beats_1080p_Direct_On_A_Hevc_Capable_Tv()
    {
        var order = Order(PlaybackDeciderTests.AndroidTv(), allowTranscoding: true, Uhd, Hd);

        Assert.Equal(Uhd, Assert.Single(order, v => v.Recommended).ReleaseId);
        Assert.Equal([Uhd, Hd], order.Select(v => v.ReleaseId));
    }

    [Fact]
    public void Same_Resolution_Prefers_Direct_Over_Remux_Even_When_Quality_Ranks_It_Lower()
    {
        var order = Order(PlaybackDeciderTests.Chrome(), allowTranscoding: true, HdMkv, Hd);

        Assert.Equal([Hd, HdMkv], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
    }

    [Fact]
    public void Only_Transcodes_Recommend_The_Best_Transcode()
    {
        var chromeH264 = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "web",
            Engines = [new EngineProfileDto { Engine = "web", Containers = ["mp4"], VideoCodecs = [new() { Codec = "h264" }], AudioCodecs = [new() { Codec = "aac" }], Hls = true }],
        });

        var order = Order(chromeH264, allowTranscoding: true, UhdSdr, HdHevc, Mpeg2);

        Assert.Equal([UhdSdr, HdHevc, Mpeg2], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
    }

    [Fact]
    public void Unplayable_Versions_Are_Never_Recommended()
    {
        var chromeH264 = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "web",
            Engines = [new EngineProfileDto { Engine = "web", Containers = ["mp4"], VideoCodecs = [new() { Codec = "h264" }], AudioCodecs = [new() { Codec = "aac" }], Hls = true }],
        });

        var order = Order(chromeH264, allowTranscoding: false, UhdSdr, Mpeg2);

        Assert.DoesNotContain(order, v => v.Recommended);
    }

    [Fact]
    public void Vlc_Direct_Counts_As_Playing_Without_A_Transcode()
    {
        var withVlc = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "tvos",
            VlcAvailable = true,
            Engines = [new EngineProfileDto { Engine = "native", Containers = ["mp4"], VideoCodecs = [new() { Codec = "h264" }], AudioCodecs = [new() { Codec = "aac" }], Hls = true }],
        });

        var order = Order(withVlc, allowTranscoding: true, Mpeg2, "Movie.2019.480p.DVDRip.H264.AAC.MP4-GRP");

        Assert.Equal(Mpeg2, Assert.Single(order, v => v.Recommended).ReleaseId);
        Assert.Equal(PlayClass.Vlc, Predictor.Classify(ReleaseParser.Parse(Mpeg2), 8000, 120,
            new PlayContext(withVlc, PlaybackPreferences.Default, FakePlaybackMedia.Available()), true));
    }

    [Fact]
    public void Vlc_Caps_Keep_Recommended_On_A_Version_That_Really_Plays()
    {
        static DeviceCaps Tv(EngineCaps vlc) => new("androidtv", new EngineCaps(EngineCaps.Native, ["mp4"], [new("h264", null, null, 8, [])],
            [new("aac", null, false)], null, true, 2), vlc, null);
        var unlimited = Tv(Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, null, null, null));
        var hevc1080 = Tv(Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps("h264,hevc:1080", null, null, null, null));
        var capped = Tv(Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, 1080, null, null, null));
        var sdr = Tv(Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, null, false, null));

        Assert.Equal(Uhd, Assert.Single(Order(unlimited, true, Uhd, HdHevc, Hd), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(hevc1080, true, Uhd, HdHevc, Hd), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(capped, true, Uhd, HdHevc, Hd), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(sdr, true, Uhd, HdHevc, Hd), v => v.Recommended).ReleaseId);
        var play = new PlayContext(hevc1080, PlaybackPreferences.Default, FakePlaybackMedia.Available());
        Assert.Equal(PlayClass.Transcode, Predictor.Classify(ReleaseParser.Parse(Uhd), 8000, 120, play, true));
        Assert.Equal(PlayClass.Vlc, Predictor.Classify(ReleaseParser.Parse(HdHevc), 8000, 120, play, true));
        Assert.Equal(PlayClass.Unplayable, Predictor.Classify(ReleaseParser.Parse(Uhd), 8000, 120, play, false));
    }

    [Fact]
    public void A_Vlc_Prediction_Explains_The_Vlc_Engine_Not_The_Native_Conversions()
    {
        var device = new DeviceCaps("ios", new EngineCaps(EngineCaps.Native, ["mp4"], [new("h264", null, null, 8, [])],
            [new("aac", null, false)], null, true, 2), Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, null, null, null), null);
        var play = new PlayContext(device, PlaybackPreferences.Default, FakePlaybackMedia.Available());

        var (playClass, prediction) = Predictor.ClassifyAndExplain(ReleaseParser.Parse(Uhd), 8000, 120, play, true);
        var (directClass, directPrediction) = Predictor.ClassifyAndExplain(ReleaseParser.Parse(Hd), 8000, 120, play, true, "mp4");

        Assert.Equal(PlayClass.Vlc, playClass);
        Assert.Equal(PlayClass.Vlc, prediction!.Method);
        var codes = prediction.Reasons.Select(r => r.Code).ToList();
        Assert.Contains("vlc_fallback", codes);
        Assert.Contains("direct_play", codes);
        Assert.DoesNotContain(codes, c => c is "video_codec_unsupported" or "hdr_unsupported" or "bit_depth_unsupported" or "audio_converted"
            or "audio_codec_unsupported" or "container_unsupported" or "resolution_exceeds_limit");
        Assert.Equal(PlayClass.Direct, directClass);
        Assert.Null(directPrediction);
    }

    [Fact]
    public void Vlc_Caps_Parse_Per_Codec_Heights_Bit_Depth_And_Hdr()
    {
        var caps = Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps("avc,hevc:1080,av1", 2160, "hdr10,dv", null, false);

        Assert.Equal(["h264", "hevc", "av1"], caps.Video.Select(v => v.Codec));
        Assert.Equal([2160, 1080, 2160], caps.Video.Select(v => v.MaxHeight));
        Assert.Equal(["hdr10", "dolbyvision"], caps.VideoFor("hevc")!.HdrFormats);
        Assert.False(caps.ToneMapsHdr);
        Assert.All(Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, null, false, null).Video,
            v => Assert.Equal((8, 0), (v.MaxBitDepth, v.HdrFormats.Count)));
        Assert.Same(EngineCaps.DefaultVlc, Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, null, null, null));
    }

    private const string HdrHevc1080 = "Movie.2019.1080p.BluRay.x265.10bit.HDR10.AAC-GRP";

    [Theory]
    [InlineData("none")]
    [InlineData("")]
    [InlineData(" NONE ")]
    public void Vlc_HdrFormats_None_Renders_No_Hdr_So_Hdr_Hevc_1080p_Transcodes(string none)
    {
        static DeviceCaps Tv(EngineCaps vlc) => new("androidtv", new EngineCaps(EngineCaps.Native, ["mp4"], [new("h264", null, null, 8, [])],
            [new("aac", null, false)], null, true, 2), vlc, null);
        var noHdr = Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps("h264,hevc:1080", null, none, null, false);
        var defaults = Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps("h264,hevc:1080", null, null, null, false);

        Assert.All(noHdr.Video, v => Assert.Empty(v.HdrFormats));
        Assert.Equal(10, noHdr.VideoFor("hevc")!.MaxBitDepth);
        Assert.NotEmpty(defaults.VideoFor("hevc")!.HdrFormats);
        Assert.Equal(PlayClass.Transcode, Classify(Tv(noHdr), HdrHevc1080));
        Assert.Equal(PlayClass.Vlc, Classify(Tv(noHdr), HdHevc));
        Assert.Equal(PlayClass.Vlc, Classify(Tv(defaults), HdrHevc1080));
        Assert.Equal(PlayClass.Unplayable, Predictor.Classify(ReleaseParser.Parse(HdrHevc1080), 8000, 120,
            new PlayContext(Tv(noHdr), PlaybackPreferences.Default, FakePlaybackMedia.Available()), false));
        Assert.Throws<Streamarr.Server.Viewers.ViewerProblem>(() =>
            Streamarr.Server.Viewers.Controllers.ViewerCatalogController.VlcCaps(null, null, "none,hdr10", null, null));
    }

    private static string? Classify(DeviceCaps device, string release)
        => Predictor.Classify(ReleaseParser.Parse(release), 8000, 120, new PlayContext(device, PlaybackPreferences.Default, FakePlaybackMedia.Available()), true);

    private const string WebDl = "Big.Buck.Bunny.2008.1080p.WEB-DL.AAC2.0.H.264-DEVWORLD";

    [Fact]
    public void Prediction_WithoutAContainerHint_AssumesMkv_UntilTheRealContainerIsKnown()
    {
        var parsed = ReleaseParser.Parse(WebDl);
        var play = new PlayContext(PlaybackDeciderTests.Chrome(), PlaybackPreferences.Default, FakePlaybackMedia.Available());
        var predictor = new PlaybackPredictor(new TranscodingSettingsService(null!, Microsoft.Extensions.Logging.Abstractions.NullLogger<TranscodingSettingsService>.Instance));
        var hints = new DeviceHints(new ClientProfile { VideoCodecs = ["h264"], AudioCodecs = ["aac"], Containers = ["mp4"] }, new TranscodeLimits(null, null));

        var assumed = predictor.Predict(parsed, 4000, 10, hints, allowTranscoding: true);
        var known = predictor.Predict(parsed, 4000, 10, hints, allowTranscoding: true, knownContainer: "mp4");

        Assert.Equal("remux", assumed.Method);
        Assert.Contains(assumed.Reasons, r => r.Code == "container_assumed");
        Assert.Equal("direct", known.Method);
        Assert.DoesNotContain(known.Reasons, r => r.Code == "container_assumed");
        Assert.Equal(PlayClass.Remux, predictor.Classify(parsed, 4000, 10, play, true));
        Assert.Equal(PlayClass.Direct, predictor.Classify(parsed, 4000, 10, play, true, "mov,mp4,m4a,3gp,3g2,mj2"));
        Assert.Equal(PlayClass.Remux, predictor.Classify(ReleaseParser.Parse("Movie.2019.1080p.WEB.MP4.H264.AAC-GRP"), 4000, 10, play, true, "mkv"));
    }

    [Theory]
    [InlineData("mp4", "mp4")]
    [InlineData(".M4V", "mp4")]
    [InlineData("mov,mp4,m4a,3gp,3g2,mj2", "mp4")]
    [InlineData("matroska,webm", "mkv")]
    [InlineData("mkv", "mkv")]
    [InlineData("m2ts", "ts")]
    [InlineData("avi", "avi")]
    [InlineData("", null)]
    public void ContainerStore_NormalizesExtensionsAndProbeFormats(string container, string? family)
    {
        var store = new ReleaseContainerStore();
        store.Record("r1", container);

        Assert.Equal(family, store.Get("r1"));
        Assert.Null(store.Get("r2"));
    }
}
