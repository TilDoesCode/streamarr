using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Watch;

/// <summary>A series' current episode: the most recent resume point when it is newer than the latest completion in that series, otherwise next up.</summary>
public static class CurrentEpisodeRule
{
    /// <summary>The in-progress episode that wins over next up, or null when next up applies.</summary>
    public static ViewerWatchStateEntity? ActiveResume(IEnumerable<ViewerWatchStateEntity> seriesStates)
    {
        ViewerWatchStateEntity? resume = null;
        DateTimeOffset? completed = null;
        foreach (var state in seriesStates)
        {
            if (state.PlayedAt is { } playedAt && (completed is null || playedAt > completed))
                completed = playedAt;
            if (state.PositionTicks > 0 && state.SeasonNumber is not null && state.EpisodeNumber is not null &&
                (resume is null || Last(state) > Last(resume)))
                resume = state;
        }
        return resume is not null && (completed is null || Last(resume) > completed) ? resume : null;
    }

    private static DateTimeOffset Last(ViewerWatchStateEntity state) => state.LastPlayedAt ?? DateTimeOffset.MinValue;
}
