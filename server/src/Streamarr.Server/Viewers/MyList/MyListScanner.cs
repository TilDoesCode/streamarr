using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.MyList;

/// <summary>One TMDB episode in airing order.</summary>
public sealed record ListEpisode(int Season, int Episode, string WorkId, string? Title, string? AirDate, string? StillUrl, int? RuntimeMinutes)
{
    public bool After(int season, int episode) => Season > season || (Season == season && Episode > episode);
}

/// <summary>Where a viewer stands in a series or season.</summary>
public sealed record SeriesScan(
    ViewerWatchStateEntity? Anchor,
    ViewerWatchStateEntity? Resume,
    ListEpisode? ResumeEpisode,
    ListEpisode? Target,
    bool TargetAired,
    int Played,
    int AiredTotal,
    bool AnyActivity,
    DateTimeOffset? LastActivity,
    bool Incomplete);

/// <summary>
/// Walks a series (or one season) against the viewer's watch state without the next-up limits: the furthest played episode
/// (anchor), the in-progress episode, and the first unplayed episode after the anchor (target), aired or not.
/// </summary>
public sealed class MyListScanner(ITmdbClient tmdb, TimeProvider time, ILogger<MyListScanner> logger)
{
    private const int MaxSeasons = 60;

    public async Task<SeriesScan> ScanAsync(TmdbTvSeriesCatalog catalog, int? season, IReadOnlyList<ViewerWatchStateEntity> states, CancellationToken ct)
    {
        var today = Today();
        var scoped = states
            .Where(s => s.Kind == "episode" && s.SeasonNumber > 0 && s.EpisodeNumber is not null && (season is null || s.SeasonNumber == season))
            .ToList();
        var byWork = scoped.GroupBy(s => s.WorkId, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var anchor = scoped.Where(s => s.Played)
            .OrderByDescending(s => s.SeasonNumber).ThenByDescending(s => s.EpisodeNumber)
            .FirstOrDefault();
        var resume = CurrentEpisodeRule.ActiveResume(scoped);
        var seasons = catalog.Seasons
            .Where(s => s.SeasonNumber > 0 && (season is null || s.SeasonNumber == season))
            .OrderBy(s => s.SeasonNumber)
            .Take(MaxSeasons)
            .ToList();
        var from = anchor?.SeasonNumber ?? seasons.FirstOrDefault()?.SeasonNumber ?? 1;
        var tmdbId = catalog.Series.TmdbId;

        var aired = 0;
        var incomplete = false;
        ListEpisode? target = null;
        ListEpisode? resumeEpisode = null;
        foreach (var summary in seasons)
        {
            var number = summary.SeasonNumber;
            var fetch = (number >= from && (anchor is not null || number == from)) || number == resume?.SeasonNumber;
            if (!fetch)
            {
                if (number < from || NextUpService.HasAired(summary.AirDate, today))
                    aired += summary.EpisodeCount;
                continue;
            }

            var episodes = await SeasonAsync(tmdbId, number, ct);
            if (episodes is null)
            {
                incomplete = true;
                if (NextUpService.HasAired(summary.AirDate, today))
                    aired += summary.EpisodeCount;
                continue;
            }
            foreach (var episode in episodes)
            {
                if (NextUpService.HasAired(episode.AirDate, today))
                    aired++;
                if (resume is not null && resume.SeasonNumber == number && resume.EpisodeNumber == episode.Episode)
                    resumeEpisode = episode;
                if (target is not null || (anchor is not null && !episode.After(anchor.SeasonNumber!.Value, anchor.EpisodeNumber!.Value)))
                    continue;
                if (byWork.TryGetValue(episode.WorkId, out var state) && state is { Played: true, PositionTicks: 0 })
                    continue;
                target = episode;
            }
        }

        return new SeriesScan(
            anchor,
            resume,
            resumeEpisode,
            target,
            target is not null && NextUpService.HasAired(target.AirDate, today),
            scoped.Count(s => s.Played),
            aired,
            scoped.Any(s => s.Played || s.PositionTicks > 0),
            scoped.Max(s => s.LastPlayedAt),
            incomplete);
    }

    public DateOnly Today() => DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);

    private async Task<IReadOnlyList<ListEpisode>?> SeasonAsync(int tmdbId, int number, CancellationToken ct)
    {
        try
        {
            var season = await tmdb.GetTvSeasonCatalogAsync(tmdbId, number, ct);
            return season?.Episodes
                .OrderBy(e => e.EpisodeNumber)
                .Select(e => new ListEpisode(number, e.EpisodeNumber, TvCatalogService.EpisodeWorkId(tmdbId, number, e.EpisodeNumber),
                    e.Title, e.AirDate, e.StillUrl, e.RuntimeMinutes))
                .ToList();
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Season {Season} of series {TmdbId} could not be loaded for the list", number, tmdbId);
            return null;
        }
    }
}
