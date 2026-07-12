using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;

namespace Streamarr.Core.Tests.Ranking;

public class ReleaseEvaluatorTests
{
    private static readonly QualityProfile Profile = DefaultProfiles.Standard;
    private static readonly ReleaseEvaluator Evaluator = new();

    [Fact]
    public void Evaluate_ScoresAndRejects_FromParsedName()
    {
        var parsed = ReleaseParser.Parse("Example.2021.1080p.WEB-DL.x265.DDP5.1-GROUP");
        var signals = ReleaseSignals.FromParsed(parsed, sizeBytes: 4_000_000_000, runtimeMinutes: 120, grabs: 50, ageDays: 10);

        var assessment = Evaluator.Evaluate(signals, Profile);

        Assert.False(assessment.Rejected);
        Assert.True(assessment.Score.Total > 0);
    }

    [Fact]
    public void Evaluate_ScoresRejectedReleaseToo()
    {
        var parsed = ReleaseParser.Parse("Example.2021.1080p.WEB-DL.x265.sample-GROUP");
        var signals = ReleaseSignals.FromParsed(parsed, sizeBytes: 4_000_000_000, runtimeMinutes: 120);

        var assessment = Evaluator.Evaluate(signals, Profile);

        Assert.True(assessment.Rejected);
        // A rejected release still has its would-be score computed for the debug view.
        Assert.True(assessment.Score.Total > 0);
    }

    [Fact]
    public void Apply_FlattensAssessmentOntoRelease()
    {
        var release = new Release
        {
            ReleaseId = "r1",
            Title = "Example.2021.720p.HDTV.x264.sample-GROUP",
            Indexer = "idx",
            SizeBytes = 40_000_000,
        };
        var parsed = ReleaseParser.Parse(release.Title);
        var signals = ReleaseSignals.FromParsed(parsed, release.SizeBytes, runtimeMinutes: 100);

        var applied = ReleaseEvaluator.Apply(release, Evaluator.Evaluate(signals, Profile));

        Assert.True(applied.Rejected);
        Assert.NotEmpty(applied.RejectionReasons);
        Assert.Contains("sample", applied.RejectionReasons[0]);
    }

    [Fact]
    public void Order_AcceptedBeforeRejected_ThenByScore()
    {
        var accepted = new Release { ReleaseId = "a", Title = "a", Indexer = "i", SizeBytes = 1, Score = 100 };
        var betterAccepted = new Release { ReleaseId = "b", Title = "b", Indexer = "i", SizeBytes = 1, Score = 500 };
        var rejectedHighScore = new Release
        {
            ReleaseId = "c", Title = "c", Indexer = "i", SizeBytes = 1, Score = 9000,
            Rejected = true, RejectionReasons = ["dead-on-usenet: dead"],
        };

        var ordered = ReleaseEvaluator.Order([accepted, rejectedHighScore, betterAccepted]);

        Assert.Equal("b", ordered[0].ReleaseId);
        Assert.Equal("a", ordered[1].ReleaseId);
        // The rejected release sorts last despite its higher raw score.
        Assert.Equal("c", ordered[2].ReleaseId);
    }

    [Fact]
    public void Order_TiesBrokenByLargerSize()
    {
        var small = new Release { ReleaseId = "small", Title = "s", Indexer = "i", SizeBytes = 1_000, Score = 100 };
        var large = new Release { ReleaseId = "large", Title = "l", Indexer = "i", SizeBytes = 9_000, Score = 100 };

        var ordered = ReleaseEvaluator.Order([small, large]);

        Assert.Equal("large", ordered[0].ReleaseId);
    }

    [Fact]
    public void EndToEnd_RanksRealReleasesSanely()
    {
        // A mixed set: the 1080p BluRay x265 should top the 720p HDTV, and the fake
        // (tiny) release should be rejected and sort last.
        var candidates = new (string Name, long Size)[]
        {
            ("Example.2021.1080p.BluRay.x265.DDP5.1-GROUP", 8_000_000_000),
            ("Example.2021.720p.HDTV.x264-OTHER", 2_000_000_000),
            ("Example.2021.1080p.WEB-DL.x265-FAKE", 30_000_000),
        };

        var releases = candidates.Select(c =>
        {
            var parsed = ReleaseParser.Parse(c.Name);
            var signals = ReleaseSignals.FromParsed(parsed, c.Size, runtimeMinutes: 120, grabs: 20, ageDays: 30);
            var release = new Release
            {
                ReleaseId = c.Name,
                Title = c.Name,
                Indexer = "idx",
                SizeBytes = c.Size,
            };
            return ReleaseEvaluator.Apply(release, Evaluator.Evaluate(signals, Profile));
        });

        var ordered = ReleaseEvaluator.Order(releases);

        Assert.Equal("Example.2021.1080p.BluRay.x265.DDP5.1-GROUP", ordered[0].ReleaseId);
        Assert.Equal("Example.2021.720p.HDTV.x264-OTHER", ordered[1].ReleaseId);
        Assert.True(ordered[2].Rejected);
    }
}
