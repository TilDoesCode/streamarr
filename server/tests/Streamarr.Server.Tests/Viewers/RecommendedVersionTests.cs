using Streamarr.Core.Parser;
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
}
