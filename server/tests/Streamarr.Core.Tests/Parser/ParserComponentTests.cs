using Streamarr.Core.Parser;

namespace Streamarr.Core.Tests.Parser;

/// <summary>
/// Focused regression tests for the individual parser components. The broad coverage
/// lives in <see cref="ReleaseCorpusTests"/>; these lock the contract of each unit.
/// </summary>
public class ParserComponentTests
{
    [Theory]
    [InlineData("Movie.2020.2160p.WEB-DL", "2160p")]
    [InlineData("Movie.2020.1080p.WEB-DL", "1080p")]
    [InlineData("Movie.2020.720p.HDTV", "720p")]
    [InlineData("Movie.2020.UHD.BluRay.HEVC", "2160p")]
    [InlineData("Movie.2020.1920x1080.BluRay", "1080p")]
    public void QualityParser_Resolution(string name, string expected)
    {
        Assert.Equal(expected, QualityParser.Parse(name).Resolution);
    }

    [Theory]
    [InlineData("Movie.2020.1080p.WEB-DL.x264", "WEB-DL")]
    [InlineData("Movie.2020.1080p.WEBRip.x264", "WEBRip")]
    [InlineData("Movie.2020.1080p.BluRay.x264", "BluRay")]
    [InlineData("Movie.2020.2160p.BluRay.REMUX.HEVC", "Remux")]
    [InlineData("Movie.2020.720p.HDTV.x264", "HDTV")]
    [InlineData("Movie.2020.BDRip.x264", "BDRip")]
    [InlineData("Movie.2020.HDCAM.x264", "CAM")]
    public void QualityParser_Source(string name, string expected)
    {
        Assert.Equal(expected, QualityParser.Parse(name).Source);
    }

    [Theory]
    [InlineData("Movie.H.265", "x265")]
    [InlineData("Movie.HEVC", "x265")]
    [InlineData("Movie.x265", "x265")]
    [InlineData("Movie.H.264", "x264")]
    [InlineData("Movie.AVC", "x264")]
    [InlineData("Movie.AV1", "AV1")]
    [InlineData("Movie.XviD", "XviD")]
    public void QualityParser_VideoCodec(string name, string expected)
    {
        Assert.Equal(expected, QualityParser.Parse(name).VideoCodec);
    }

    [Fact]
    public void QualityParser_ProperRepackVersion()
    {
        var proper = QualityParser.Parse("Movie.2020.PROPER.1080p.WEB-DL");
        Assert.True(proper.Proper);
        Assert.Equal(2, proper.Version);

        var repack = QualityParser.Parse("Movie.2020.REPACK.1080p.WEB-DL");
        Assert.True(repack.Repack);
        Assert.Equal(2, repack.Version);
    }

    [Theory]
    [InlineData("Movie.DV.HDR.HEVC", "DV")]
    [InlineData("Movie.Dolby.Vision.HEVC", "DV")]
    [InlineData("Movie.HDR10Plus.HEVC", "HDR10+")]
    [InlineData("Movie.HDR10.HEVC", "HDR10")]
    [InlineData("Movie.HDR.HEVC", "HDR10")]
    [InlineData("Movie.HLG.HEVC", "HLG")]
    [InlineData("Movie.SDR.x264", "SDR")]
    [InlineData("Movie.1080p.x264", null)]
    public void HdrParser_Flavor(string name, string? expected)
    {
        Assert.Equal(expected, HdrParser.Parse(name));
    }

    [Theory]
    [InlineData("Movie.TrueHD.7.1.Atmos", "TrueHD", "7.1", true)]
    [InlineData("Movie.DTS-HD.MA.5.1", "DTS-HD MA", "5.1", false)]
    [InlineData("Movie.DDP5.1", "DDP", "5.1", false)]
    [InlineData("Movie.DD+5.1", "DDP", "5.1", false)]
    [InlineData("Movie.AAC2.0", "AAC", "2.0", false)]
    [InlineData("Movie.DTS.x264", "DTS", null, false)]
    public void AudioParser_CodecChannelsAtmos(string name, string codec, string? channels, bool atmos)
    {
        var result = AudioParser.Parse(name);
        Assert.Equal(codec, result.Codec);
        Assert.Equal(channels, result.Channels);
        Assert.Equal(atmos, result.Atmos);
    }

    [Fact]
    public void LanguageParser_GermanDualLanguage()
    {
        var result = LanguageParser.Parse("Movie.2020.German.DL.1080p.BluRay.x264");
        Assert.Contains("de", result.Languages);
        Assert.True(result.DualAudio);
    }

    [Fact]
    public void LanguageParser_Multi()
    {
        Assert.True(LanguageParser.Parse("Movie.2020.MULTi.1080p.BluRay.x264").Multi);
    }

    [Fact]
    public void EpisodeParser_SingleAndMulti()
    {
        var single = EpisodeParser.Parse("Show.S01E05.1080p.WEB-DL.x264");
        Assert.NotNull(single);
        Assert.Equal(1, single!.Season);
        Assert.Equal(new[] { 5 }, single.Episodes);

        var multi = EpisodeParser.Parse("Show.S01E05E06.1080p.WEB-DL.x264");
        Assert.Equal(new[] { 5, 6 }, multi!.Episodes);
    }

    [Fact]
    public void EpisodeParser_SeasonPackAndDaily()
    {
        var pack = EpisodeParser.Parse("Show.S02.1080p.BluRay.x264");
        Assert.True(pack!.SeasonPack);
        Assert.Equal(2, pack.Season);

        var daily = EpisodeParser.Parse("Show.2023.03.15.1080p.WEB-DL.x264");
        Assert.True(daily!.IsDaily);
        Assert.Equal("2023-03-15", daily.AirDate);
    }

    [Fact]
    public void EpisodeParser_ReturnsNullForMovie()
    {
        Assert.Null(EpisodeParser.Parse("Some.Movie.2021.1080p.BluRay.x264-GROUP"));
    }

    [Fact]
    public void ReleaseGroupParser_MovieAndAnime()
    {
        Assert.Equal("SPARKS", ReleaseGroupParser.Parse("Movie.2020.1080p.BluRay.x264-SPARKS"));
        Assert.Equal("SubsPlease", ReleaseGroupParser.Parse("[SubsPlease] Frieren - 07 (1080p) [ABCD1234].mkv"));
    }

    [Fact]
    public void ReleaseParser_ProducesFullShape()
    {
        var p = ReleaseParser.Parse("The.Matrix.1999.1080p.BluRay.x264.DTS-HD.MA.5.1-FGT");
        Assert.Equal("The Matrix", p.Title);
        Assert.Equal(1999, p.Year);
        Assert.Equal(ParsedMediaType.Movie, p.MediaType);
        Assert.Equal("1080p", p.Resolution);
        Assert.Equal("BluRay", p.Source);
        Assert.Equal("x264", p.VideoCodec);
        Assert.Equal("DTS-HD MA", p.AudioCodec);
        Assert.Equal("5.1", p.AudioChannels);
        Assert.Equal("FGT", p.ReleaseGroup);
    }
}
