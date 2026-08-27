using Streamarr.Core.Media;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class NextEpisodeReleaseSelectionTests
{
    private const string Current = "Dark.S03E07.German.DL.1080p.NF.WEBRip.x264-D3GI";

    [Fact]
    public void DisabledUsesHighestRankedRelease()
    {
        var selected = NextEpisodeResolver.SelectRelease(
            [
                Candidate("same-family", 100, "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-D3GI"),
                Candidate("highest-score", 1_000, "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-SAUERKRAUT"),
            ],
            Current,
            preferSimilarRelease: false,
            ReleaseSimilarityScorer.DefaultThreshold);

        Assert.Equal("highest-score", selected!.Release.ReleaseId);
    }

    [Fact]
    public void EnabledLetsStrongSimilarityBeatRankingScore()
    {
        var selected = NextEpisodeResolver.SelectRelease(
            [
                Candidate("highest-score", 1_000, "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-SAUERKRAUT"),
                Candidate("same-family", 100, "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-D3GI"),
            ],
            Current,
            preferSimilarRelease: true,
            ReleaseSimilarityScorer.DefaultThreshold);

        Assert.Equal("same-family", selected!.Release.ReleaseId);
    }

    [Fact]
    public void NoCandidateClearsThresholdFallsBackToHighestScore()
    {
        var selected = NextEpisodeResolver.SelectRelease(
            [
                Candidate("highest-score", 1_000, "Dark.S03E08.English.2160p.AMZN.WEB-DL.x265-SAUERKRAUT"),
                Candidate("same-group-wrong-class", 100, "Dark.S03E08.English.2160p.AMZN.WEB-DL.x265-D3GI"),
            ],
            Current,
            preferSimilarRelease: true,
            ReleaseSimilarityScorer.DefaultThreshold);

        Assert.Equal("highest-score", selected!.Release.ReleaseId);
    }

    [Fact]
    public void ThresholdIsInclusive()
    {
        var selected = NextEpisodeResolver.SelectRelease(
            [
                Candidate("fallback", 1_000, "Dark.S03E08.English.2160p.AMZN.WEB-DL.x265-SAUERKRAUT"),
                Candidate("same-family", 100, "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-D3GI"),
            ],
            Current,
            preferSimilarRelease: true,
            similarityThreshold: 100);

        Assert.Equal("same-family", selected!.Release.ReleaseId);
    }

    [Fact]
    public void SimilarityTieUsesScoreThenStableReleaseId()
    {
        var title = "Dark.S03E08.German.DL.1080p.NF.WEBRip.x264-D3GI";
        var selectedByScore = NextEpisodeResolver.SelectRelease(
            [Candidate("lower", 100, title), Candidate("higher", 200, title)],
            Current,
            preferSimilarRelease: true,
            ReleaseSimilarityScorer.DefaultThreshold);
        var selectedById = NextEpisodeResolver.SelectRelease(
            [Candidate("release-b", 200, title), Candidate("release-a", 200, title)],
            Current,
            preferSimilarRelease: true,
            ReleaseSimilarityScorer.DefaultThreshold);

        Assert.Equal("higher", selectedByScore!.Release.ReleaseId);
        Assert.Equal("release-a", selectedById!.Release.ReleaseId);
    }

    [Fact]
    public void ZeroThresholdStillExcludesAnExplicitLanguageMismatch()
    {
        var selected = NextEpisodeResolver.SelectRelease(
            [
                Candidate("wrong-language", 1_000, "Dark.S03E08.English.1080p.NF.WEBRip.x264-D3GI"),
                Candidate("language-unknown", 100, "Dark.S03E08.1080p"),
            ],
            Current,
            preferSimilarRelease: true,
            similarityThreshold: 0);

        Assert.Equal("language-unknown", selected!.Release.ReleaseId);
    }

    private static RegisteredRelease Candidate(string id, int score, string title)
        => new()
        {
            WorkId = "target",
            Release = new Release
            {
                ReleaseId = id,
                Title = title,
                Indexer = "test",
                SizeBytes = 1_000,
                Score = score,
            },
        };
}
