using Streamarr.Core.Parser;

namespace Streamarr.Core.Tests.Parser;

public class StreamDetailParserTests
{
    [Theory]
    [InlineData("Movie.2021.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-GRP", 10)]
    [InlineData("Movie.2021.1080p.WEB-DL.10-Bit.HEVC-GRP", 10)]
    [InlineData("Show.S01E01.1080p.BluRay.Hi10P.FLAC-GRP", 10)]
    [InlineData("Movie.2021.1080p.BluRay.HEVC.Main10.DDP5.1-GRP", 10)]
    [InlineData("Movie.2021.2160p.WEB-DL.12bit.DV-GRP", 12)]
    [InlineData("Movie.2021.1080p.BluRay.8bit.x264-GRP", 8)]
    [InlineData("Sintel.2010.1080p.BluRay.DTS.5.1.HDR10.10bit.x265-DEVWORLD", 10)]
    [InlineData("Movie.2021.1080p.BluRay.DDP5.1.x264-GRP", null)]
    [InlineData("Movie.2021.1080p.BluRay.DDP5.1.10.Cloverfield.Lane.x264-GRP", null)]
    public void BitDepth_IsReadFromExplicitMarkersOnly(string name, int? expected)
        => Assert.Equal(expected, ReleaseParser.Parse(name).BitDepth);

    [Theory]
    [InlineData("Movie.2021.2160p.WEB-DL.DV.HDR10.DDP5.1.Atmos.H.265-GRP", "DV,HDR10")]
    [InlineData("Movie.2021.2160p.WEB-DL.DoVi.HDR10+.H.265-GRP", "DV,HDR10+")]
    [InlineData("Movie.2021.2160p.WEB-DL.DV.H.265-GRP", "DV")]
    [InlineData("Movie.2021.2160p.BluRay.HDR.x265-GRP", "HDR10")]
    [InlineData("Show.S01E01.2160p.HLG.HEVC-GRP", "HLG")]
    [InlineData("Movie.2021.1080p.BluRay.x264-GRP", "")]
    public void HdrFormats_ListEveryNamedFlavorDominantFirst(string name, string expected)
    {
        var parsed = ReleaseParser.Parse(name);

        Assert.Equal(expected, string.Join(',', parsed.HdrFormats));
        Assert.Equal(parsed.HdrFormats.FirstOrDefault(), parsed.Hdr);
    }

    [Theory]
    [InlineData("Movie.2021.1080p.WEB-DL.x264.MULTiSUBS-GRP", "subbed,multi", "")]
    [InlineData("Movie.2021.German.Subbed.1080p.BluRay.x264-GRP", "subbed", "de")]
    [InlineData("Movie.2021.1080p.BluRay.x264.NLSubs-GRP", "subbed", "nl")]
    [InlineData("Movie.2021.720p.HDRip.HC.x264-GRP", "hardcoded", "")]
    [InlineData("Movie.2021.1080p.WEB.H264.HardSub.ENG-GRP", "hardcoded", "")]
    [InlineData("Movie.2021.VOSTFR.1080p.WEB.x264-GRP", "subbed", "fr")]
    [InlineData("Movie.2021.VOSTA.1080p.WEB.x264-GRP", "subbed", "en")]
    [InlineData("Movie.2021.1080p.BluRay.x264.SWESUB-GRP", "subbed", "sv")]
    [InlineData("Movie.2021.1080p.WEB-DL.Subs.EN.x264-GRP", "subbed", "en")]
    [InlineData("Suburbicon.2017.1080p.BluRay.x264-GRP", "", "")]
    [InlineData("The.Substance.2024.1080p.WEB-DL.x264-GRP", "", "")]
    [InlineData("Sintel.2010.German.DL.1080p.BluRay.DD5.1.x264-DEVWORLD", "", "")]
    public void SubtitleHints_ComeFromSubtitleMarkers(string name, string hints, string languages)
    {
        var parsed = ReleaseParser.Parse(name);

        Assert.Equal(hints, string.Join(',', parsed.SubtitleHints));
        Assert.Equal(languages, string.Join(',', parsed.SubtitleLanguages));
    }
}
