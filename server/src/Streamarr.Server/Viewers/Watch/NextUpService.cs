using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Watch;

public sealed record NextUpItem(
    string WorkId,
    string SeriesWorkId,
    string SeriesTitle,
    string? SeriesPosterUrl,
    string? SeriesBackdropUrl,
    int SeasonNumber,
    int EpisodeNumber,
    string EpisodeTitle,
    string? AirDate,
    string? StillUrl,
    int? RuntimeMinutes,
    long PositionTicks,
    long? DurationTicks,
    string LastWatchedWorkId,
    DateTimeOffset LastActivityAt);

public sealed record NextUpResult(IReadOnlyList<NextUpItem> Items, bool Incomplete);

/// <summary>Suggests the first unplayed, already aired episode after the furthest played one per recently watched series.</summary>
public sealed class NextUpService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    ITmdbClient tmdb,
    TimeProvider time,
    ILogger<NextUpService> logger)
{
    private const int MaxSeasonLookahead = 3;
    private const int Parallelism = 4;

    public async Task<NextUpResult> GetAsync(string viewerId, string? seriesWorkId, int limit, CancellationToken ct)
    {
        limit = Math.Clamp(limit, 1, 50);
        var current = await settings.GetAsync(ct);
        var now = time.GetUtcNow();
        var cutoff = now.AddDays(-current.NextUpCutoffDays);

        List<ViewerWatchStateEntity> episodes;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var query = db.ViewerWatchStates.AsNoTracking()
                .Where(s => s.ViewerId == viewerId && s.Kind == "episode" && s.SeriesWorkId != null);
            if (seriesWorkId is not null)
                query = query.Where(s => s.SeriesWorkId == seriesWorkId);
            episodes = await query.ToListAsync(ct);
        }

        var candidates = episodes
            .GroupBy(s => s.SeriesWorkId!)
            .Select(g => new SeriesProgress(
                g.Key,
                g.First().TmdbId!.Value,
                g.Max(s => s.LastPlayedAt) ?? DateTimeOffset.MinValue,
                g.Where(s => s.Played && s.SeasonNumber > 0)
                    .OrderByDescending(s => s.SeasonNumber).ThenByDescending(s => s.EpisodeNumber)
                    .FirstOrDefault(),
                g.ToDictionary(s => s.WorkId, StringComparer.Ordinal)))
            .Where(p => p.Anchor is not null && (seriesWorkId is not null || p.LastActivity >= cutoff))
            .OrderByDescending(p => p.LastActivity)
            .Take(limit * 2)
            .ToList();

        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var items = new List<NextUpItem>();
        var incomplete = false;
        foreach (var batch in candidates.Chunk(Parallelism))
        {
            var results = await Task.WhenAll(batch.Select(p => ResolveAsync(p, today, ct)));
            foreach (var (item, failed) in results)
            {
                incomplete |= failed;
                if (item is not null)
                    items.Add(item);
            }
            if (items.Count >= limit)
                break;
        }

        return new NextUpResult(items.Take(limit).ToList(), incomplete);
    }

    public static bool HasAired(string? airDate, DateOnly today)
        => DateOnly.TryParseExact(airDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) && date <= today;

    private async Task<(NextUpItem? Item, bool Failed)> ResolveAsync(SeriesProgress progress, DateOnly today, CancellationToken ct)
    {
        try
        {
            var series = await tmdb.GetTvSeriesCatalogAsync(progress.TmdbId, ct);
            if (series is null)
                return (null, true);

            var anchor = progress.Anchor!;
            var seasons = series.Seasons
                .Select(s => s.SeasonNumber)
                .Where(n => n >= anchor.SeasonNumber && n > 0)
                .Order()
                .Take(MaxSeasonLookahead + 1);
            foreach (var number in seasons)
            {
                var season = await tmdb.GetTvSeasonCatalogAsync(progress.TmdbId, number, ct);
                if (season is null)
                    return (null, true);
                foreach (var episode in season.Episodes.OrderBy(e => e.EpisodeNumber))
                {
                    if (number == anchor.SeasonNumber && episode.EpisodeNumber <= anchor.EpisodeNumber)
                        continue;
                    if (!HasAired(episode.AirDate, today))
                        return (null, false);
                    var key = WorkKey.ForEpisode(progress.TmdbId, number, episode.EpisodeNumber);
                    progress.States.TryGetValue(key.WorkId, out var state);
                    if (state is { Played: true, PositionTicks: 0 })
                        continue;
                    return (new NextUpItem(
                        key.WorkId,
                        progress.SeriesWorkId,
                        series.Series.Title,
                        series.Series.PosterUrl,
                        series.Series.BackdropUrl,
                        number,
                        episode.EpisodeNumber,
                        episode.Title,
                        episode.AirDate,
                        episode.StillUrl,
                        episode.RuntimeMinutes,
                        state?.PositionTicks ?? 0,
                        state?.DurationTicks,
                        anchor.WorkId,
                        progress.LastActivity), false);
                }
            }
            return (null, false);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Next-up lookup for {SeriesWorkId} failed", progress.SeriesWorkId);
            return (null, true);
        }
    }

    private sealed record SeriesProgress(
        string SeriesWorkId,
        int TmdbId,
        DateTimeOffset LastActivity,
        ViewerWatchStateEntity? Anchor,
        Dictionary<string, ViewerWatchStateEntity> States);
}
