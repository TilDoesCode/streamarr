using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Viewers.Watch;

public sealed record ViewerContext(string ViewerId, string Username, string DeviceName);

/// <summary>Per-viewer watch state: progress ingestion, played flags, continue-watching and history.</summary>
public sealed class WatchStateService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ViewerSettingsService settings,
    ITmdbClient tmdb,
    WatchEventService watchEvents,
    TimeProvider time,
    ILogger<WatchStateService> logger)
{
    public const string EventSource = "streamarr-viewer";
    public const int MaxBatch = 500;
    private readonly KeyedAsyncLock _locks = new();

    public async Task<ViewerWatchStateEntity> ReportAsync(ViewerContext viewer, WatchReport report, CancellationToken ct)
    {
        if (!report.Work.IsPlayable)
            throw ViewerProblem.BadRequest("invalid_work_id", "Progress can only be reported for a movie or an episode.");

        var current = await settings.GetAsync(ct);
        ViewerWatchStateEntity state;
        using (await _locks.AcquireAsync(viewer.ViewerId, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow();
            state = await FindOrCreateAsync(db, viewer.ViewerId, report.Work, now, ct);
            WatchProgressRules.Apply(state, report, current, now);
            await db.SaveChangesAsync(ct);
        }

        await ForwardAsync(viewer, report, ct);
        return state;
    }

    /// <summary>Marks works played (season and series ids expand to aired episodes via TMDB) or clears them locally.</summary>
    public async Task<IReadOnlyList<string>> SetPlayedAsync(string viewerId, IReadOnlyList<WorkKey> works, bool played, CancellationToken ct)
    {
        if (!played)
            return await ClearPlayedAsync(viewerId, works, ct);

        var targets = new List<(WorkKey Key, string? Title)>();
        try
        {
            foreach (var work in works)
                targets.AddRange(work.IsPlayable ? [(work, null)] : await ExpandAsync(work, ct));
        }
        catch (Exception e) when (e is not ViewerProblem and not OperationCanceledException)
        {
            logger.LogDebug(e, "Expanding a season or series to its episodes failed");
            throw new ViewerProblem(StatusCodes.Status503ServiceUnavailable, "catalog_unavailable", "TMDB could not list the episodes; try again later.");
        }
        targets = targets.DistinctBy(t => t.Key.WorkId).Take(MaxBatch * 4).ToList();

        using (await _locks.AcquireAsync(viewerId, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow();
            var ids = targets.Select(t => t.Key.WorkId).ToList();
            var existing = await db.ViewerWatchStates
                .Where(s => s.ViewerId == viewerId && ids.Contains(s.WorkId))
                .ToDictionaryAsync(s => s.WorkId, StringComparer.Ordinal, ct);
            foreach (var (target, title) in targets)
            {
                if (!existing.TryGetValue(target.WorkId, out var state))
                {
                    state = NewState(viewerId, target, now);
                    db.ViewerWatchStates.Add(state);
                }
                state.Title ??= title;
                WatchProgressRules.MarkCompleted(state, playbackId: null, now);
                state.LastPlayedAt = now;
                state.UpdatedAt = now;
            }
            await db.SaveChangesAsync(ct);
            return ids;
        }
    }

    private async Task<IReadOnlyList<string>> ClearPlayedAsync(string viewerId, IReadOnlyList<WorkKey> works, CancellationToken ct)
    {
        var ids = works.Where(w => w.IsPlayable).Select(w => w.WorkId).ToHashSet(StringComparer.Ordinal);
        var series = works.Where(w => w.Kind == WorkKind.Series).Select(w => w.SeriesWorkId!).ToHashSet(StringComparer.Ordinal);
        var seasons = works.Where(w => w.Kind == WorkKind.Season).Select(w => (w.SeriesWorkId!, w.Season)).ToHashSet();
        var parents = series.Concat(seasons.Select(s => s.Item1)).Distinct().ToList();
        var idList = ids.ToList();

        using (await _locks.AcquireAsync(viewerId, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var candidates = await db.ViewerWatchStates
                .Where(s => s.ViewerId == viewerId && (idList.Contains(s.WorkId) || parents.Contains(s.SeriesWorkId!)))
                .ToListAsync(ct);
            var matched = candidates.Where(s =>
                    ids.Contains(s.WorkId) ||
                    (s.SeriesWorkId is { } parent && (series.Contains(parent) || seasons.Contains((parent, s.SeasonNumber)))))
                .ToList();
            db.ViewerWatchStates.RemoveRange(matched);
            await db.SaveChangesAsync(ct);
            return matched.Select(s => s.WorkId).ToList();
        }
    }

    public async Task RemoveFromResumeAsync(string viewerId, WorkKey work, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        await db.ViewerWatchStates.Where(s => s.ViewerId == viewerId && s.WorkId == work.WorkId)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.PositionTicks, 0L).SetProperty(x => x.UpdatedAt, time.GetUtcNow()), ct);
    }

    public async Task<IReadOnlyList<ViewerWatchStateEntity>> GetAsync(string viewerId, IReadOnlyCollection<string> workIds, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerWatchStates.AsNoTracking()
            .Where(s => s.ViewerId == viewerId && workIds.Contains(s.WorkId))
            .ToListAsync(ct);
    }

    public async Task<IReadOnlyList<ViewerWatchStateEntity>> GetSeriesAsync(string viewerId, string seriesWorkId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerWatchStates.AsNoTracking()
            .Where(s => s.ViewerId == viewerId && s.SeriesWorkId == seriesWorkId)
            .OrderBy(s => s.SeasonNumber).ThenBy(s => s.EpisodeNumber)
            .ToListAsync(ct);
    }

    public async Task<IReadOnlyList<ViewerWatchStateEntity>> ResumeAsync(string viewerId, int limit, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerWatchStates.AsNoTracking()
            .Where(s => s.ViewerId == viewerId && s.PositionTicks > 0)
            .OrderByDescending(s => s.LastPlayedAt)
            .Take(Math.Clamp(limit, 1, 100))
            .ToListAsync(ct);
    }

    public async Task<(IReadOnlyList<ViewerWatchStateEntity> Items, int Total)> HistoryAsync(string viewerId, int limit, int offset, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var query = db.ViewerWatchStates.AsNoTracking().Where(s => s.ViewerId == viewerId && s.LastPlayedAt != null);
        var total = await query.CountAsync(ct);
        var items = await query.OrderByDescending(s => s.LastPlayedAt)
            .Skip(Math.Max(0, offset))
            .Take(Math.Clamp(limit, 1, 200))
            .ToListAsync(ct);
        return (items, total);
    }

    public async Task<int> ClearAsync(string viewerId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.ViewerWatchStates.Where(s => s.ViewerId == viewerId).ExecuteDeleteAsync(ct);
    }

    public async Task<Dictionary<string, WatchSummary>> SummariesAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.ViewerWatchStates.AsNoTracking()
            .GroupBy(s => s.ViewerId)
            .Select(g => new { g.Key, Played = g.Count(s => s.Played), InProgress = g.Count(s => s.PositionTicks > 0), Last = g.Max(s => s.LastPlayedAt) })
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.Key, r => new WatchSummary(r.Played, r.InProgress, r.Last));
    }

    private async Task<IReadOnlyList<(WorkKey Key, string? Title)>> ExpandAsync(WorkKey work, CancellationToken ct)
    {
        if (work.TmdbId is not { } tmdbId)
            return [];
        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var series = await tmdb.GetTvSeriesCatalogAsync(tmdbId, ct);
        IEnumerable<int> seasons = work.Kind == WorkKind.Season
            ? [work.Season!.Value]
            : series?.Seasons.Where(s => s.SeasonNumber > 0).Select(s => s.SeasonNumber)
              ?? throw ViewerProblem.BadRequest("catalog_unavailable", "The series could not be loaded from TMDB.");

        var result = new List<(WorkKey, string?)>();
        foreach (var number in seasons)
        {
            var season = await tmdb.GetTvSeasonCatalogAsync(tmdbId, number, ct)
                         ?? throw ViewerProblem.BadRequest("catalog_unavailable", $"Season {number} could not be loaded from TMDB.");
            result.AddRange(season.Episodes
                .Where(e => NextUpService.HasAired(e.AirDate, today))
                .Select(e => (WorkKey.ForEpisode(tmdbId, number, e.EpisodeNumber),
                    series is null ? null : (string?)$"{series.Series.Title} · S{number:D2}E{e.EpisodeNumber:D2} · {e.Title}")));
        }
        return result;
    }

    private async Task ForwardAsync(ViewerContext viewer, WatchReport report, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(report.ReleaseId))
            return;
        try
        {
            await watchEvents.RecordAsync(new WatchEventWrite
            {
                ReleaseId = report.ReleaseId,
                WorkId = report.Work.WorkId,
                Title = report.Title,
                Event = report.Event,
                PositionTicks = report.PositionTicks,
                DurationTicks = report.DurationTicks,
                SessionToken = report.StreamToken,
                Source = EventSource,
                PlaybackSessionId = report.PlaybackId,
                ExternalUserId = viewer.ViewerId,
                ExternalUserName = viewer.Username,
                DeviceName = viewer.DeviceName,
            }, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "Forwarding a viewer playback event to the shared event stream failed");
        }
    }

    private static async Task<ViewerWatchStateEntity> FindOrCreateAsync(
        StreamarrDbContext db, string viewerId, WorkKey work, DateTimeOffset now, CancellationToken ct)
    {
        var state = await db.ViewerWatchStates.SingleOrDefaultAsync(s => s.ViewerId == viewerId && s.WorkId == work.WorkId, ct);
        if (state is not null)
            return state;
        state = NewState(viewerId, work, now);
        db.ViewerWatchStates.Add(state);
        return state;
    }

    private static ViewerWatchStateEntity NewState(string viewerId, WorkKey work, DateTimeOffset now) => new()
    {
        ViewerId = viewerId,
        WorkId = work.WorkId,
        Kind = work.KindName,
        TmdbId = work.TmdbId,
        SeriesWorkId = work.SeriesWorkId,
        SeasonNumber = work.Season,
        EpisodeNumber = work.Episode,
        UpdatedAt = now,
    };
}

public sealed record WatchSummary(int Played, int InProgress, DateTimeOffset? LastPlayedAt);
