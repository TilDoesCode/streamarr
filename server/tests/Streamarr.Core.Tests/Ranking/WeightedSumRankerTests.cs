using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;

namespace Streamarr.Core.Tests.Ranking;

public class WeightedSumRankerTests
{
    private static readonly QualityProfile Profile = DefaultProfiles.Standard;
    private static readonly WeightedSumRanker Ranker = new();

    private static ReleaseSignals Signals(
        string? resolution = "1080p",
        string? source = "WEB-DL",
        string? codec = "x265",
        string? audio = "DDP",
        string? group = null,
        int ageDays = 30,
        int grabs = 100,
        long sizeBytes = 4_000_000_000,
        int? runtime = 120,
        bool proper = false,
        IReadOnlyList<string>? languages = null) => new()
    {
        ReleaseName = "test",
        Resolution = resolution,
        Source = source,
        VideoCodec = codec,
        AudioCodec = audio,
        ReleaseGroup = group,
        AgeDays = ageDays,
        Grabs = grabs,
        SizeBytes = sizeBytes,
        RuntimeMinutes = runtime,
        Proper = proper,
        Languages = languages ?? ["en"],
    };

    [Fact]
    public void BreakdownSumsToTotal()
    {
        var score = Ranker.Score(Signals(), Profile);
        Assert.Equal(score.Total, score.Breakdown.Sum(l => l.Points));
    }

    [Fact]
    public void PreferredResolution_ScoresHigherThanLessPreferred()
    {
        var best = Ranker.Score(Signals(resolution: "1080p"), Profile).Total;
        var worse = Ranker.Score(Signals(resolution: "720p"), Profile).Total;
        Assert.True(best > worse, $"1080p ({best}) should outrank 720p ({worse})");
    }

    [Fact]
    public void PreferredSource_ScoresHigherThanLessPreferred()
    {
        var best = Ranker.Score(Signals(source: "BluRay"), Profile).Total;
        var worse = Ranker.Score(Signals(source: "HDTV"), Profile).Total;
        Assert.True(best > worse);
    }

    [Fact]
    public void ProperRepack_AddsBonus()
    {
        var plain = Ranker.Score(Signals(proper: false), Profile).Total;
        var proper = Ranker.Score(Signals(proper: true), Profile).Total;
        Assert.Equal(plain + Profile.ProperRepackBonus, proper);
    }

    [Fact]
    public void NewerRelease_ScoresHigherThanOlder()
    {
        var fresh = Ranker.Score(Signals(ageDays: 1), Profile).Total;
        var old = Ranker.Score(Signals(ageDays: 400), Profile).Total;
        Assert.True(fresh > old);
    }

    [Fact]
    public void MoreGrabs_ScoreHigherThanFewer()
    {
        var popular = Ranker.Score(Signals(grabs: 1000), Profile).Total;
        var obscure = Ranker.Score(Signals(grabs: 1), Profile).Total;
        Assert.True(popular > obscure);
    }

    [Fact]
    public void HigherAudioTier_ScoresHigher()
    {
        var lossless = Ranker.Score(Signals(audio: "TrueHD"), Profile).Total;
        var lossy = Ranker.Score(Signals(audio: "AAC"), Profile).Total;
        Assert.True(lossless > lossy);
    }

    [Fact]
    public void AllowedGroup_AddsBonus()
    {
        var profile = Profile with { GroupAllowList = ["GOODGRP"] };
        var allowed = Ranker.Score(Signals(group: "GOODGRP"), profile).Total;
        var neutral = Ranker.Score(Signals(group: "OTHER"), profile).Total;
        Assert.Equal(neutral + profile.GroupAllowBonus, allowed);
    }

    [Fact]
    public void DeniedGroup_SinksBelowZero()
    {
        var profile = Profile with { GroupDenyList = ["BADGRP"] };
        var denied = Ranker.Score(Signals(group: "BADGRP"), profile);
        Assert.Contains(denied.Breakdown, l => l.Rule == "group-deny" && l.Points < 0);
        Assert.True(denied.Total < 0);
    }

    [Fact]
    public void UnknownValues_ScoreZero()
    {
        var score = Ranker.Score(
            new ReleaseSignals { ReleaseName = "junk", Grabs = 0, AgeDays = 10_000 },
            Profile);
        Assert.Equal(0, score.Total);
        Assert.Empty(score.Breakdown);
    }

    [Fact]
    public void GroupDeny_IsRankingConcern_NotRejection()
    {
        // A denied group is heavily penalised in ranking but never hard-rejected here
        // (BRIEF §7.2 keeps deny-list out of the rejection engine).
        var profile = Profile with { GroupDenyList = ["BADGRP"] };
        var reasons = new RejectionEngine().Evaluate(Signals(group: "BADGRP"), profile);
        Assert.Empty(reasons);
    }
}
