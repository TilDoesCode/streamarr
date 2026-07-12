using Streamarr.Core.Ranking;

namespace Streamarr.Core.Tests.Ranking;

public class QualityDefinitionsTests
{
    [Fact]
    public void ResolutionTiers_OrderedHighToLow()
    {
        Assert.True(QualityDefinitions.ResolutionTier("2160p") > QualityDefinitions.ResolutionTier("1080p"));
        Assert.True(QualityDefinitions.ResolutionTier("1080p") > QualityDefinitions.ResolutionTier("720p"));
        Assert.True(QualityDefinitions.ResolutionTier("720p") > QualityDefinitions.ResolutionTier("480p"));
        Assert.Equal(0, QualityDefinitions.ResolutionTier(null));
    }

    [Fact]
    public void SourceTiers_MatchRadarrOrdering()
    {
        Assert.True(QualityDefinitions.SourceTier("Remux") > QualityDefinitions.SourceTier("BluRay"));
        Assert.True(QualityDefinitions.SourceTier("BluRay") > QualityDefinitions.SourceTier("WEB-DL"));
        Assert.True(QualityDefinitions.SourceTier("WEB-DL") > QualityDefinitions.SourceTier("HDTV"));
        Assert.True(QualityDefinitions.SourceTier("HDTV") > QualityDefinitions.SourceTier("CAM"));
        Assert.Equal(0, QualityDefinitions.SourceTier(null));
    }

    [Fact]
    public void AudioTiers_LosslessBeatsLossy()
    {
        Assert.True(QualityDefinitions.AudioTier("TrueHD") > QualityDefinitions.AudioTier("DDP"));
        Assert.True(QualityDefinitions.AudioTier("DDP") > QualityDefinitions.AudioTier("AAC"));
        Assert.True(QualityDefinitions.AudioTier("AAC") > QualityDefinitions.AudioTier("MP3"));
    }

    [Theory]
    [InlineData("2160p")]
    [InlineData("1080p")]
    [InlineData("720p")]
    [InlineData("480p")]
    public void DefaultSizeBands_HaveSaneBounds(string resolution)
    {
        var band = QualityDefinitions.DefaultSizeBands[resolution];
        Assert.True(band.MinBytesPerMinute > 0);
        Assert.True(band.MaxBytesPerMinute > band.MinBytesPerMinute);
    }

    [Fact]
    public void HigherResolutionBands_AllowMoreBytesPerMinute()
    {
        var uhd = QualityDefinitions.DefaultSizeBands["2160p"];
        var hd = QualityDefinitions.DefaultSizeBands["1080p"];
        Assert.True(uhd.MaxBytesPerMinute > hd.MaxBytesPerMinute);
    }
}
