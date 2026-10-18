using Streamarr.Core.Parser;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Device-aware "Recommended": the ranker score minus a penalty for how a version plays on the device, from the release names.</summary>
public sealed class RecommendedVersionTests
{
    private const string Uhd = "Movie.2019.2160p.UHD.BluRay.x265.10bit.HDR10.TrueHD.7.1-GRP";
    private const string UhdSdr = "Movie.2019.2160p.WEB-DL.x265.AAC-GRP";
    private const string HdHevc = "Movie.2019.1080p.WEB-DL.x265.AAC-GRP";
    private const string Hd = "Movie.2019.1080p.WEB-DL.H264.AAC.MP4-GRP";
    private const string HdMkv = "Movie.2019.1080p.BluRay.H264.AAC-OTHER";
    private const string Mpeg2 = "Movie.2019.720p.HDTV.MPEG2.AC3-GRP";

    private static readonly PlaybackPredictor Predictor = new(null!);

    /// <summary>Device order of versions with the given (viewer) scores; <c>qualityRank</c> is the score order.</summary>
    private static List<VersionDto> Order(DeviceCaps device, bool allowTranscoding, params (string Name, int Score)[] versions)
        => Order(device, allowTranscoding, [], versions);

    /// <summary>Like <see cref="Order(DeviceCaps, bool, ValueTuple{string, int}[])"/>, with <paramref name="downloaded"/> already on disk.</summary>
    private static List<VersionDto> Order(DeviceCaps device, bool allowTranscoding, string[] downloaded, params (string Name, int Score)[] versions)
    {
        var play = new PlayContext(device, PlaybackPreferences.Default, FakePlaybackMedia.Available());
        return ViewerCatalogService.DeviceOrder(versions.OrderByDescending(v => v.Score).Select((v, i) =>
        {
            var version = new VersionDto
            {
                ReleaseId = v.Name, Name = v.Name, Rank = i + 1, QualityRank = i + 1, Health = "unknown",
                Local = downloaded.Contains(v.Name) ? "ready" : null,
            };
            return (version, (string?)Predictor.Classify(ReleaseParser.Parse(v.Name), 8000, 120, play, allowTranscoding), v.Score);
        }).ToList());
    }

    private static string[] Classes(DeviceCaps device, bool allowTranscoding, params string[] names)
    {
        var play = new PlayContext(device, PlaybackPreferences.Default, FakePlaybackMedia.Available());
        return names.Select(n => Predictor.Classify(ReleaseParser.Parse(n), 8000, 120, play, allowTranscoding)).ToArray();
    }

    private static readonly DeviceCaps ChromeH264 = DeviceCaps.Parse(new DeviceProfileDto
    {
        Platform = "web",
        Engines = [new EngineProfileDto { Engine = "web", Containers = ["mp4"], VideoCodecs = [new() { Codec = "h264" }], AudioCodecs = [new() { Codec = "aac" }], Hls = true }],
    });

    [Fact]
    public void Penalties_Follow_The_Play_Class()
    {
        Assert.Equal([0, 5, 10, 40, 40, 0], new[] { PlayClass.Direct, PlayClass.Remux, PlayClass.Vlc, PlayClass.Transcode, PlayClass.Unknown, null }
            .Select(ViewerCatalogService.DevicePenalty));
    }

    [Fact]
    public void A_Downloaded_Version_Comes_First_And_Is_Recommended_Even_When_It_Transcodes()
    {
        var chrome = PlaybackDeciderTests.Chrome(hdr: false);
        Assert.Equal([PlayClass.Transcode, PlayClass.Direct, PlayClass.Remux], Classes(chrome, true, Uhd, Hd, HdMkv));

        var order = Order(chrome, allowTranscoding: true, [Uhd], (Hd, 300), (HdMkv, 200), (Uhd, 250));

        Assert.Equal([Uhd, Hd, HdMkv], order.Select(v => v.ReleaseId));
        Assert.Equal(Uhd, Assert.Single(order, v => v.Recommended).ReleaseId);
        Assert.Equal([2, 1, 3], order.Select(v => v.QualityRank));
    }

    [Fact]
    public void A_Downloaded_Version_The_Device_Cannot_Play_Stays_Last_And_Unrecommended()
    {
        Assert.Equal([PlayClass.Unplayable, PlayClass.Direct], Classes(ChromeH264, false, UhdSdr, Hd));

        var order = Order(ChromeH264, allowTranscoding: false, [UhdSdr], (UhdSdr, 400), (Hd, 100));

        Assert.Equal([Hd, UhdSdr], order.Select(v => v.ReleaseId));
        Assert.Equal(Hd, Assert.Single(order, v => v.Recommended).ReleaseId);
    }

    [Fact]
    public void Without_A_Device_Profile_Downloaded_Then_Score_Order_And_The_First_Is_Recommended()
    {
        var versions = new[] { ("a", 300), ("b", 200), ("c", 100) }.Select((v, i) =>
            (new VersionDto { ReleaseId = v.Item1, Name = v.Item1, Rank = i + 1, QualityRank = i + 1, Health = "unknown", Local = v.Item1 == "c" ? "ready" : null },
                (string?)null, v.Item2)).ToList();

        var order = ViewerCatalogService.DeviceOrder(versions);

        Assert.Equal(["c", "a", "b"], order.Select(v => v.ReleaseId));
        Assert.Equal([true, false, false], order.Select(v => v.Recommended));
    }

    [Fact]
    public void The_Affinity_Bonus_Never_Outweighs_A_Transcode_Against_An_Equal_Direct_Play()
    {
        var chrome = PlaybackDeciderTests.Chrome(hdr: false);
        Assert.Equal([PlayClass.Transcode, PlayClass.Direct], Classes(chrome, true, Uhd, Hd));

        var order = Order(chrome, allowTranscoding: true, (Uhd, 200 + ViewerReleaseAffinity.Bonus), (Hd, 200));

        Assert.Equal(Hd, Assert.Single(order, v => v.Recommended).ReleaseId);
    }

    private const string Played = "Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-ALPHA";

    [Fact]
    public void Affinity_Rewards_The_Same_Group_And_Format_Only()
    {
        var points = ViewerReleaseAffinity.Points(Played,
        [
            ("Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-ALPHA", 0),
            ("Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-BETA", 0),
            ("Show.S01E02.2160p.BluRay.REMUX.HEVC.TrueHD-GAMMA", 0),
        ]);

        Assert.Equal([ViewerReleaseAffinity.Bonus, 0, 0], points);
        Assert.All(ViewerReleaseAffinity.Points(null, [("Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-ALPHA", 0)]), p => Assert.Equal(0, p));
        Assert.Empty(ViewerReleaseAffinity.Points(Played, []));
    }

    [Fact]
    public void Affinity_Only_Applies_In_The_Best_Viewer_Language_On_Offer()
    {
        var points = ViewerReleaseAffinity.Points(Played,
        [
            ("Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-ALPHA", 0),
            ("Show.S01E02.German.1080p.WEB-DL.DDP5.1.H.264-ALPHA", 60),
            ("Show.S01E02.German.1080p.WEB-DL.DDP5.1.H.264-GAMMA", 60),
        ]);

        Assert.Equal([0, ViewerReleaseAffinity.Bonus, 0], points);
    }

    [Fact]
    public void A_Higher_Scored_1080p_Direct_Beats_A_4k_Remux_On_A_Hevc_Capable_Tv()
    {
        var tv = PlaybackDeciderTests.AndroidTv();
        Assert.Equal([PlayClass.Remux, PlayClass.Direct], Classes(tv, true, Uhd, Hd));

        var order = Order(tv, allowTranscoding: true, (Uhd, 200), (Hd, 220));

        Assert.Equal([Hd, Uhd], order.Select(v => v.ReleaseId));
        Assert.Equal(Hd, Assert.Single(order, v => v.Recommended).ReleaseId);
        Assert.Equal((1, 1), (order[0].Rank, order[0].QualityRank));
    }

    [Fact]
    public void A_Clearly_Better_4k_Remux_Beats_A_1080p_Direct_On_A_Hevc_Capable_Tv()
    {
        var order = Order(PlaybackDeciderTests.AndroidTv(), allowTranscoding: true, (Uhd, 260), (Hd, 220));

        Assert.Equal([Uhd, Hd], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
    }

    [Fact]
    public void Within_A_Play_Class_The_Standard_Profile_Score_Decides_Not_The_Resolution()
    {
        static int Score(string name) => new WeightedSumRanker().Score(
            ReleaseSignals.FromParsed(ReleaseParser.Parse(name), 8_000_000_000, 120), DefaultProfiles.Standard).Total;
        var tv = PlaybackDeciderTests.AndroidTv();
        var classes = Classes(tv, true, UhdSdr, HdHevc);
        Assert.Equal(classes[0], classes[1]);
        Assert.True(Score(HdHevc) > Score(UhdSdr), $"1080p {Score(HdHevc)} vs 2160p {Score(UhdSdr)}");

        var order = Order(tv, allowTranscoding: true, (UhdSdr, Score(UhdSdr)), (HdHevc, Score(HdHevc)));

        Assert.Equal([HdHevc, UhdSdr], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
    }

    [Theory]
    [InlineData(200, new[] { Hd, HdMkv })]
    [InlineData(204, new[] { Hd, HdMkv })]
    [InlineData(205, new[] { Hd, HdMkv })]
    [InlineData(206, new[] { HdMkv, Hd })]
    public void Direct_Beats_Remux_Unless_The_Remux_Scores_More_Than_The_Remux_Penalty_Higher(int remuxScore, string[] expected)
    {
        Assert.Equal([PlayClass.Remux, PlayClass.Direct], Classes(PlaybackDeciderTests.Chrome(), true, HdMkv, Hd));

        var order = Order(PlaybackDeciderTests.Chrome(), allowTranscoding: true, (HdMkv, remuxScore), (Hd, 200));

        Assert.Equal(expected, order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
        int[] qualityRanks = expected[0] == HdMkv ? [1, 2] : [2, 1];
        Assert.Equal(qualityRanks, order.Select(v => v.QualityRank));
    }

    [Theory]
    [InlineData(230, Hd)]
    [InlineData(240, Hd)]
    [InlineData(241, Uhd)]
    public void A_Transcode_Needs_More_Than_The_Transcode_Penalty_Over_A_Direct_Play(int uhdScore, string recommended)
    {
        var chrome = PlaybackDeciderTests.Chrome(hdr: false);
        Assert.Equal([PlayClass.Transcode, PlayClass.Direct], Classes(chrome, true, Uhd, Hd));

        var order = Order(chrome, allowTranscoding: true, (Uhd, uhdScore), (Hd, 200));

        Assert.Equal(recommended, Assert.Single(order, v => v.Recommended).ReleaseId);
        Assert.Equal(1, order.Single(v => v.ReleaseId == Uhd).QualityRank);
    }

    [Fact]
    public void Only_Transcodes_Recommend_The_Best_Scored_Transcode()
    {
        Assert.All(Classes(ChromeH264, true, UhdSdr, HdHevc), c => Assert.Equal(PlayClass.Transcode, c));

        var order = Order(ChromeH264, allowTranscoding: true, (UhdSdr, 180), (HdHevc, 210), (Mpeg2, 120));

        Assert.Equal([HdHevc, UhdSdr, Mpeg2], order.Select(v => v.ReleaseId));
        Assert.True(order[0].Recommended);
    }

    [Fact]
    public void Unplayable_Versions_Come_Last_And_Are_Never_Recommended()
    {
        Assert.Equal([PlayClass.Unplayable, PlayClass.Direct], Classes(ChromeH264, false, UhdSdr, Hd));

        var order = Order(ChromeH264, allowTranscoding: false, (UhdSdr, 400), (Hd, 100));
        var nothing = Order(ChromeH264, allowTranscoding: false, (UhdSdr, 300), (Mpeg2, 200));

        Assert.Equal([Hd, UhdSdr], order.Select(v => v.ReleaseId));
        Assert.Equal((true, false), (order[0].Recommended, order[1].Recommended));
        Assert.Equal([1, 2], order.Select(v => v.Rank));
        Assert.DoesNotContain(nothing, v => v.Recommended);
    }

    [Fact]
    public void Vlc_Direct_Counts_Its_Small_Penalty_Against_A_Direct_Play()
    {
        var withVlc = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "tvos",
            VlcAvailable = true,
            Engines = [new EngineProfileDto { Engine = "native", Containers = ["mp4"], VideoCodecs = [new() { Codec = "h264" }], AudioCodecs = [new() { Codec = "aac" }], Hls = true }],
        });
        const string Dvd = "Movie.2019.480p.DVDRip.H264.AAC.MP4-GRP";
        Assert.Equal([PlayClass.Vlc, PlayClass.Direct], Classes(withVlc, true, Mpeg2, Dvd));

        Assert.Equal(Mpeg2, Assert.Single(Order(withVlc, true, (Mpeg2, 120), (Dvd, 100)), v => v.Recommended).ReleaseId);
        Assert.Equal(Dvd, Assert.Single(Order(withVlc, true, (Mpeg2, 108), (Dvd, 100)), v => v.Recommended).ReleaseId);
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
        (string, int)[] scored = [(Uhd, 230), (HdHevc, 205), (Hd, 200)];

        Assert.Equal(Uhd, Assert.Single(Order(unlimited, true, scored), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(hevc1080, true, scored), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(capped, true, scored), v => v.Recommended).ReleaseId);
        Assert.Equal(Hd, Assert.Single(Order(sdr, true, scored), v => v.Recommended).ReleaseId);
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
        Assert.Equal(PlayClass.Direct, directPrediction.Method);
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
