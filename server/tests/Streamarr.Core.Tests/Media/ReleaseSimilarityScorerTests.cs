using Streamarr.Core.Media;

namespace Streamarr.Core.Tests.Media;

public sealed class ReleaseSimilarityScorerTests
{
    private const string Current = "Dark.S03E07.German.DL.1080p.NF.WEBRip.x264-D3GI";

    [Theory]
    [InlineData("Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-D3GI")]
    [InlineData("Dark S03E08 GERMAN DL 1080p NF WEB-Rip H.264-d3gi.mkv")]
    [InlineData("Dark.S03.German.DL.1080p.NF.WEBRip.x264-D3GI")]
    public void SameReleaseFamily_ClearsDefaultThreshold(string candidate)
    {
        var score = ReleaseSimilarityScorer.Score(Current, candidate);

        Assert.InRange(score, ReleaseSimilarityScorer.DefaultThreshold, 100);
    }

    [Fact]
    public void EpisodeIdentityIsIgnored()
    {
        var score = ReleaseSimilarityScorer.Score(
            "The.Bear.S02E01.German.DL.1080p.DSNP.WEB-DL.DDP5.1.H.264-SAUERKRAUT",
            "The.Bear.S02E09.German.DL.1080p.DSNP.WEB-DL.DDP5.1.H.264-SAUERKRAUT");

        Assert.Equal(100, score);
    }

    [Fact]
    public void DifferentReleaseGroup_StaysBelowDefaultThreshold()
    {
        var score = ReleaseSimilarityScorer.Score(
            Current,
            "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-SAUERKRAUT");

        Assert.Equal(60, score);
        Assert.True(score < ReleaseSimilarityScorer.DefaultThreshold);
    }

    [Fact]
    public void SameGroupButDifferentReleaseClass_StaysBelowDefaultThreshold()
    {
        var score = ReleaseSimilarityScorer.Score(
            Current,
            "Dark.S03E08.German.DL.2160p.AMZN.WEB-DL.x265-D3GI");

        Assert.True(score < ReleaseSimilarityScorer.DefaultThreshold);
    }

    [Fact]
    public void ExplicitLanguageChange_CannotClearThresholdEvenWithinSameReleaseFamily()
    {
        var score = ReleaseSimilarityScorer.Score(
            Current,
            "Dark.S03E08.English.1080p.NF.WEBRip.x264-D3GI");

        Assert.Equal(0, score);
    }

    [Fact]
    public void SeasonPackAndEpisodeFromSameFamilyMatch()
    {
        var score = ReleaseSimilarityScorer.Score(
            "Some.Show.S01.German.DL.1080p.NF.WEB-DL.x264-D3GI",
            "Some.Show.S01E02.German.DL.1080p.NF.WEB-DL.x264-D3GI");

        Assert.Equal(100, score);
    }

    [Fact]
    public void MissingGroupsCanMatchOnStrongTechnicalEvidence()
    {
        var score = ReleaseSimilarityScorer.Score(
            "The.Office.S03E01.1080p.NF.WEB-DL.x264",
            "The.Office.S03E02.1080p.NF.WEB-DL.H.264");

        Assert.InRange(score, ReleaseSimilarityScorer.DefaultThreshold, 100);
    }

    [Fact]
    public void OneGenericQualityTokenIsNotEnoughEvidence()
    {
        var score = ReleaseSimilarityScorer.Score(
            "Show.S01E01.1080p",
            "Show.S01E02.1080p");

        Assert.Equal(0, score);
    }

    [Theory]
    [InlineData(null, "candidate")]
    [InlineData("", "candidate")]
    [InlineData("source", null)]
    public void MissingTitleReturnsZero(string? source, string? candidate)
        => Assert.Equal(0, ReleaseSimilarityScorer.Score(source, candidate));

    [Fact]
    public void InputLengthIsBoundedWithoutLosingTheReleaseSuffix()
    {
        var padding = new string('x', ReleaseSimilarityScorer.MaximumInputLength * 4);
        var score = ReleaseSimilarityScorer.Score(
            $"Show.{padding}.S01E01.1080p.WEB-DL.x264-D3GI",
            $"Show.{padding}.S01E02.1080p.WEB-DL.x264-D3GI");

        Assert.InRange(score, ReleaseSimilarityScorer.DefaultThreshold, 100);
    }
}
