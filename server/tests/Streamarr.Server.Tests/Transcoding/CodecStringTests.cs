using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class CodecStringTests
{
    private static byte[] Hex(string hex) => Convert.FromHexString(hex.Replace(" ", string.Empty));

    private static SourceVideoStream Video(string codec, string? profile = null, int? level = null, int bitDepth = 8)
        => new() { Index = 0, Codec = codec, Profile = profile, Level = level, BitDepth = bitDepth };

    [Theory]
    [InlineData("01 02 20000000 900000000000 96", "hvc1.2.4.L150.90")]
    [InlineData("01 01 60000000 900000000000 5d", "hvc1.1.6.L93.90")]
    [InlineData("01 01 60000000 b00000000000 78", "hvc1.1.6.L120.B0")]
    [InlineData("01 62 20000000 b00000000001 99", "hvc1.A2.4.H153.B0.00.00.00.00.01")]
    [InlineData("01 01 60000000 000000000000 5d", "hvc1.1.6.L93.00")]
    public void Hevc_FromHvcC_FollowsIso14496Part15AnnexE(string hvcC, string expected)
        => Assert.Equal(expected, CodecStrings.HevcFromHvcC(Hex(hvcC + " f000fcfdfafa0000")));

    [Fact]
    public void Hevc_FromAnnexB_RemovesEmulationPreventionBytes()
    {
        var sps = Hex("00000001 4201 01 01 600000 03 00 90 0000 03 0000 03 00 5d 00f0");
        var withVps = Hex("00000001 4001 0c01ffff") .Concat(sps).ToArray();

        Assert.Equal("hvc1.1.6.L93.90", CodecStrings.HevcFromAnnexB(withVps));
    }

    [Theory]
    [InlineData("01 640028 ffe1001967640028acd9", "avc1.640028")]
    [InlineData("01 4d401f ffe1", "avc1.4d401f")]
    public void Avc_FromAvcC_UsesProfileConstraintsAndLevel(string avcC, string expected)
        => Assert.Equal(expected, CodecStrings.AvcFromAvcC(Hex(avcC)));

    [Fact]
    public void Avc_FromAnnexB_ReadsTheSps()
    {
        var extradata = Hex("0000016764 0028acd9407802 27e5c044 00000300 04 000003 00c03c60c658 00000001 68ef8fcb");

        Assert.Equal("avc1.640028", CodecStrings.AvcFromAnnexB(extradata));
    }

    [Theory]
    [InlineData("81080c00", "av01.0.08M.08")]
    [InlineData("810dc000", "av01.0.13H.10")]
    [InlineData("812ce000", "av01.1.12H.12")]
    public void Av1_FromAv1C(string av1C, string expected)
        => Assert.Equal(expected, CodecStrings.Av1FromAv1C(Hex(av1C)));

    [Fact]
    public void Video_PrefersTheConfigurationRecord_AndFallsBackToProbeFields()
    {
        var hevc = Video("hevc", "Main 10", 153, 10);

        Assert.Equal("hvc1.2.4.L150.90", CodecStrings.Video(hevc, new VideoCodecConfig(VideoCodecConfig.HvcC, Hex("01022000000090000000000096"))));
        Assert.Equal("hvc1.2.4.L153.B0", CodecStrings.Video(hevc, null));
        Assert.Equal("hvc1.2.4.L153.B0", CodecStrings.Video(hevc, new VideoCodecConfig(VideoCodecConfig.HvcC, [1, 2])));
        Assert.Equal("avc1.640029", CodecStrings.Video(Video("h264", "High", 41), null));
        Assert.Equal("avc1.42401e", CodecStrings.Video(Video("h264", "Constrained Baseline", 30), null));
        Assert.Equal("avc1.6e0033", CodecStrings.Video(Video("h264", "High 10", 51, 10), null));
        Assert.Equal("hvc1.1.6.L120.B0", CodecStrings.Video(Video("hevc", "Main"), null));
        Assert.Equal("av01.0.08M.10", CodecStrings.Video(Video("av1", "Main", 8, 10), null));
    }

    [Theory]
    [InlineData("aac", "LC", "mp4a.40.2")]
    [InlineData("aac", null, "mp4a.40.2")]
    [InlineData("aac", "HE-AAC", "mp4a.40.5")]
    [InlineData("aac", "HE-AACv2", "mp4a.40.29")]
    [InlineData("ac3", null, "ac-3")]
    [InlineData("eac3", null, "ec-3")]
    [InlineData("flac", null, "fLaC")]
    [InlineData("opus", null, "Opus")]
    public void Audio_UsesTheHlsSampleEntryNames(string codec, string? profile, string expected)
        => Assert.Equal(expected, CodecStrings.Audio(codec, profile));
}
