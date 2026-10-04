using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Tests.Viewers;

public class CurrentEpisodeRuleTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 12, 0, 0, TimeSpan.Zero);

    private static ViewerWatchStateEntity Episode(int season, int episode, long position = 0, int? lastMinute = null, int? playedMinute = null) => new()
    {
        ViewerId = "v",
        WorkId = $"tmdb-tv-1-s{season:D2}e{episode:D2}",
        Kind = "episode",
        SeriesWorkId = "tmdb-tv-1",
        SeasonNumber = season,
        EpisodeNumber = episode,
        PositionTicks = position,
        Played = playedMinute is not null,
        PlayedAt = playedMinute is { } p ? T0.AddMinutes(p) : null,
        LastPlayedAt = (lastMinute ?? playedMinute) is { } l ? T0.AddMinutes(l) : null,
    };

    [Fact]
    public void Replay_Of_A_Watched_Episode_Newer_Than_The_Latest_Completion_Wins()
    {
        var replay = Episode(2, 2, position: 100, lastMinute: 30, playedMinute: 5);
        var states = new[] { Episode(2, 1, playedMinute: 1), replay, Episode(2, 3, playedMinute: 10) };
        Assert.Same(replay, CurrentEpisodeRule.ActiveResume(states));
    }

    [Fact]
    public void A_Resume_Point_Older_Than_The_Latest_Completion_Leaves_Next_Up()
    {
        var states = new[] { Episode(1, 3, position: 100, lastMinute: 5), Episode(1, 4, playedMinute: 10) };
        Assert.Null(CurrentEpisodeRule.ActiveResume(states));
    }

    [Fact]
    public void The_Most_Recent_Resume_Point_Wins_And_Equal_Times_Are_Not_Newer()
    {
        var latest = Episode(1, 2, position: 100, lastMinute: 20);
        Assert.Same(latest, CurrentEpisodeRule.ActiveResume([Episode(1, 5, position: 100, lastMinute: 15), latest]));
        Assert.Same(latest, CurrentEpisodeRule.ActiveResume([latest]));
        Assert.Null(CurrentEpisodeRule.ActiveResume([Episode(1, 1, position: 100, lastMinute: 10), Episode(1, 2, playedMinute: 10)]));
        Assert.Null(CurrentEpisodeRule.ActiveResume([Episode(1, 1, playedMinute: 3)]));
    }
}
