using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Artwork;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.MyList;

/// <summary>A viewer's list ("My List"): entries, derived status and progress without the next-up cutoff, and the new-episode flag.</summary>
public sealed class MyListService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    WatchStateService watch,
    MyListScanner scanner,
    ITmdbClient tmdb,
    ArtworkPaletteService palettes,
    CatalogSpecStore specs,
    ViewerCatalogService viewerCatalog,
    SpecWarmupService warmup,
    TimeProvider time,
    ILogger<MyListService> logger)
{
    public const int MaxEntries = 2_000;
    private const int Parallelism = 4;

    public async Task<MyListResponse> ListAsync(ViewerEntity viewer, string? status, int limit, int offset, CancellationToken ct)
    {
        var all = await ComputeAllAsync(viewer, ct);
        var filtered = status is null ? all : all.Where(i => i.Status == status).ToList();
        return new MyListResponse
        {
            Items = filtered.Skip(Math.Max(0, offset)).Take(Math.Clamp(limit, 1, 500)).ToList(),
            Total = filtered.Count,
            Incomplete = all.Any(i => i.Incomplete),
        };
    }

    public async Task<MyListSummaryResponse> SummaryAsync(ViewerEntity viewer, CancellationToken ct)
    {
        var all = await ComputeAllAsync(viewer, ct);
        return new MyListSummaryResponse
        {
            NewCount = all.Count(i => i.IsNew),
            Total = all.Count,
            WantToWatch = all.Count(i => i.Status == MyListStatus.WantToWatch),
            Watching = all.Count(i => i.Status == MyListStatus.Watching),
            CaughtUp = all.Count(i => i.Status == MyListStatus.CaughtUp),
            Watched = all.Count(i => i.Status == MyListStatus.Watched),
        };
    }

    public async Task<MyListEntryStatusResponse> StatusAsync(ViewerEntity viewer, WorkKey key, CancellationToken ct)
    {
        RequireListable(key);
        List<ViewerListEntryEntity> entries;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            entries = await db.ViewerListEntries.AsNoTracking()
                .Where(e => e.ViewerId == viewer.Id && !e.Dismissed && (e.WorkId == key.WorkId || e.WorkId == key.SeriesWorkId))
                .ToListAsync(ct);
        }
        var entry = entries.FirstOrDefault(e => e.WorkId == key.WorkId);
        var item = entry is null ? null : (await ComputeAsync(viewer, [entry], ct)).FirstOrDefault();
        return new MyListEntryStatusResponse
        {
            WorkId = key.WorkId,
            OnList = entry is not null,
            Item = item,
            SeriesOnList = key.Kind == WorkKind.Season ? entries.Any(e => e.WorkId == key.SeriesWorkId) : null,
        };
    }

    public async Task<MyListItemDto> AddAsync(ViewerEntity viewer, WorkKey key, string? status, CancellationToken ct)
    {
        RequireListable(key);
        if (status is not null && status is not (MyListStatus.WantToWatch or MyListStatus.Watched))
            throw ViewerProblem.BadRequest("invalid_status", "'status' must be want_to_watch, watched or null.");

        ViewerListEntryEntity entry;
        using (await watch.LockAsync(viewer.Id, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var now = time.GetUtcNow();
            entry = await db.ViewerListEntries.SingleOrDefaultAsync(e => e.ViewerId == viewer.Id && e.WorkId == key.WorkId, ct)
                    ?? await NewEntryAsync(db, viewer.Id, key, now, ct);
            if (entry.Dismissed)
            {
                entry.Dismissed = false;
                entry.AddedAt = now;
            }
            entry.Source = MyListTracking.Manual;
            entry.StatusOverride = status;
            entry.StatusOverrideAt = status is null ? null : now;
            entry.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
        }
        return (await ComputeAsync(viewer, [entry], ct)).First();
    }

    /// <summary>Removes an entry; a series stays as a tombstone so starting it again does not re-add it.</summary>
    public async Task<bool> RemoveAsync(string viewerId, WorkKey key, CancellationToken ct)
    {
        RequireListable(key);
        using (await watch.LockAsync(viewerId, ct))
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entry = await db.ViewerListEntries.SingleOrDefaultAsync(e => e.ViewerId == viewerId && e.WorkId == key.WorkId, ct);
            if (entry is null || entry.Dismissed)
                return false;
            if (key.Kind == WorkKind.Series)
            {
                entry.Dismissed = true;
                entry.NewAvailableSince = null;
                entry.StatusOverride = null;
                entry.StatusOverrideAt = null;
                entry.UpdatedAt = time.GetUtcNow();
            }
            else
            {
                db.ViewerListEntries.Remove(entry);
            }
            await db.SaveChangesAsync(ct);
            return true;
        }
    }

    /// <summary>Clears the new flag of an entry (and of the series' seasons for a series id).</summary>
    public async Task<bool> SeenAsync(string viewerId, WorkKey key, CancellationToken ct)
    {
        RequireListable(key);
        var now = time.GetUtcNow();
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var query = db.ViewerListEntries.Where(e => e.ViewerId == viewerId && e.NewAvailableSince != null);
        query = key.Kind == WorkKind.Series
            ? query.Where(e => e.SeriesWorkId == key.WorkId)
            : query.Where(e => e.WorkId == key.WorkId);
        return await query.ExecuteUpdateAsync(s => s
            .SetProperty(e => e.NewAvailableSince, (DateTimeOffset?)null)
            .SetProperty(e => e.SeenAt, now)
            .SetProperty(e => e.UpdatedAt, now), ct) > 0;
    }

    private static void RequireListable(WorkKey key)
    {
        if (key.Kind is not (WorkKind.Movie or WorkKind.Series or WorkKind.Season) || key.TmdbId is null)
            throw ViewerProblem.BadRequest("invalid_work_id", "Only movies, series and seasons can be on the list.");
    }

    private static async Task<ViewerListEntryEntity> NewEntryAsync(StreamarrDbContext db, string viewerId, WorkKey key, DateTimeOffset now, CancellationToken ct)
    {
        if (await db.ViewerListEntries.CountAsync(e => e.ViewerId == viewerId, ct) >= MaxEntries)
            throw ViewerProblem.Conflict("list_full", $"The list holds at most {MaxEntries} titles.");
        var entry = new ViewerListEntryEntity
        {
            ViewerId = viewerId,
            WorkId = key.WorkId,
            Kind = key.KindName,
            TmdbId = key.TmdbId!.Value,
            SeriesWorkId = key.SeriesWorkId,
            SeasonNumber = key.Season,
            Source = MyListTracking.Manual,
            AddedAt = now,
            UpdatedAt = now,
        };
        db.ViewerListEntries.Add(entry);
        return entry;
    }

    private async Task<IReadOnlyList<MyListItemDto>> ComputeAllAsync(ViewerEntity viewer, CancellationToken ct)
    {
        List<ViewerListEntryEntity> entries;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            entries = await db.ViewerListEntries.AsNoTracking()
                .Where(e => e.ViewerId == viewer.Id && !e.Dismissed)
                .Take(MaxEntries)
                .ToListAsync(ct);
        }
        var items = await ComputeAsync(viewer, entries, ct);
        return items
            .OrderByDescending(i => i.IsNew)
            .ThenByDescending(i => i.IsNew ? i.NewAvailableSince : null)
            .ThenByDescending(i => i.LastActivityAt > i.AddedAt ? i.LastActivityAt : i.AddedAt)
            .ToList();
    }

    private async Task<IReadOnlyList<MyListItemDto>> ComputeAsync(ViewerEntity viewer, IReadOnlyList<ViewerListEntryEntity> entries, CancellationToken ct)
    {
        if (entries.Count == 0)
            return [];
        var seriesIds = entries.Where(e => e.SeriesWorkId != null).Select(e => e.SeriesWorkId!).Distinct().ToList();
        var movieIds = entries.Where(e => e.Kind == "movie").Select(e => e.WorkId).ToList();
        List<ViewerWatchStateEntity> states;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            states = await db.ViewerWatchStates.AsNoTracking()
                .Where(s => s.ViewerId == viewer.Id && ((s.SeriesWorkId != null && seriesIds.Contains(s.SeriesWorkId)) || movieIds.Contains(s.WorkId)))
                .ToListAsync(ct);
        }
        var bySeries = states.Where(s => s.SeriesWorkId != null).GroupBy(s => s.SeriesWorkId!)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<ViewerWatchStateEntity>)g.ToList(), StringComparer.Ordinal);
        var byWork = states.GroupBy(s => s.WorkId).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        using var gate = new SemaphoreSlim(Parallelism);
        var tasks = entries.Select(async entry =>
        {
            await gate.WaitAsync(ct);
            try
            {
                return entry.Kind == "movie"
                    ? await MovieAsync(viewer, entry, byWork.GetValueOrDefault(entry.WorkId), ct)
                    : await SeriesAsync(viewer, entry, bySeries.GetValueOrDefault(entry.SeriesWorkId ?? string.Empty) ?? [], ct);
            }
            finally
            {
                gate.Release();
            }
        });
        var items = (await Task.WhenAll(tasks)).OfType<MyListItemDto>().ToList();
        warmup.Request(items.Where(i => i.NextEpisode is not null && specs.Available(i.NextEpisode.WorkId) is null).Select(i => i.NextEpisode!.WorkId));
        return items;
    }

    private async Task<MyListItemDto?> MovieAsync(ViewerEntity viewer, ViewerListEntryEntity entry, ViewerWatchStateEntity? state, CancellationToken ct)
    {
        TmdbMatch? movie = null;
        var incomplete = false;
        try
        {
            movie = await tmdb.GetMovieAsync(entry.TmdbId, ct);
            incomplete = movie is null;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Movie {TmdbId} could not be loaded for the list", entry.TmdbId);
            incomplete = true;
        }
        if (!Allowed(viewer, entry, movie?.OfficialRating, movie is null))
            return null;

        var derived = state switch
        {
            { Played: true, PositionTicks: 0 } => MyListStatus.Watched,
            { PositionTicks: > 0 } or { Played: true } => MyListStatus.Watching,
            _ => MyListStatus.WantToWatch,
        };
        var palette = movie is null ? null : palettes.For(movie.BackdropUrl, movie.PosterUrl);
        return new MyListItemDto
        {
            WorkId = entry.WorkId,
            Kind = entry.Kind,
            TmdbId = entry.TmdbId,
            Title = movie?.Title ?? state?.Title ?? entry.WorkId,
            Year = movie?.Year,
            PosterUrl = movie?.PosterUrl,
            BackdropUrl = movie?.BackdropUrl,
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Status = Override(entry, derived, state?.LastPlayedAt),
            Source = entry.Source,
            PositionTicks = state?.PositionTicks ?? 0,
            DurationTicks = state?.DurationTicks,
            AddedAt = entry.AddedAt,
            LastActivityAt = state?.LastPlayedAt,
            Incomplete = incomplete,
        };
    }

    private async Task<MyListItemDto?> SeriesAsync(ViewerEntity viewer, ViewerListEntryEntity entry, IReadOnlyList<ViewerWatchStateEntity> states, CancellationToken ct)
    {
        TmdbTvSeriesCatalog? catalog = null;
        try
        {
            catalog = await tmdb.GetTvSeriesCatalogAsync(entry.TmdbId, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Series {TmdbId} could not be loaded for the list", entry.TmdbId);
        }
        if (!Allowed(viewer, entry, catalog?.Series.OfficialRating, catalog is null))
            return null;

        var season = entry.Kind == "season" ? entry.SeasonNumber : null;
        var isNew = entry.NewAvailableSince is not null && entry.NewEpisodeWorkId is { } newEpisode &&
                    !states.Any(s => s.WorkId == newEpisode && s is { Played: true, PositionTicks: 0 });
        if (catalog is null)
            return Offline(entry, states, season, isNew);

        var scan = await scanner.ScanAsync(catalog, season, states, ct);
        var series = catalog.Series;
        CatalogNextEpisodeDto? next = null;
        if (scan.Resume is { } resume)
            next = Episode(series, scan.ResumeEpisode, resume.SeasonNumber!.Value, resume.EpisodeNumber!.Value, "resume", resume) with
            {
                Title = scan.ResumeEpisode?.Title ?? resume.Title,
            };
        else if (scan.Target is { } target && scan.TargetAired)
            next = Episode(series, target, target.Season, target.Episode, scan.Anchor is null ? "start" : "next", null);
        if (next is not null)
            next = next with { Available = viewerCatalog.Available(viewer, next.WorkId) ?? true };
        var upcoming = scan.Target is { } later && !scan.TargetAired
            ? Episode(series, later, later.Season, later.Episode, "upcoming", null)
            : null;

        string derived;
        if (!scan.AnyActivity)
            derived = MyListStatus.WantToWatch;
        else if (next is { Available: true })
            derived = MyListStatus.Watching;
        else if (next is not null || upcoming is not null)
            derived = MyListStatus.CaughtUp;
        else
            derived = season is not null || catalog.Ended ? MyListStatus.Watched : MyListStatus.CaughtUp;

        var seasonSummary = season is null ? null : catalog.Seasons.FirstOrDefault(s => s.SeasonNumber == season);
        var palette = palettes.For(series.BackdropUrl, series.PosterUrl);
        return new MyListItemDto
        {
            WorkId = entry.WorkId,
            Kind = entry.Kind,
            TmdbId = entry.TmdbId,
            SeriesWorkId = entry.SeriesWorkId,
            SeasonNumber = entry.SeasonNumber,
            Title = season is null ? series.Title : seasonSummary?.Title ?? $"Season {season}",
            SeriesTitle = season is null ? null : series.Title,
            Year = series.Year,
            PosterUrl = seasonSummary?.PosterUrl ?? series.PosterUrl,
            BackdropUrl = series.BackdropUrl,
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Status = Override(entry, derived, scan.LastActivity),
            Source = entry.Source,
            IsNew = isNew,
            NewAvailableSince = isNew ? entry.NewAvailableSince : null,
            NewEpisodeWorkId = isNew ? entry.NewEpisodeWorkId : null,
            PlayedEpisodes = scan.Played,
            TotalEpisodes = Math.Max(scan.AiredTotal, scan.Played),
            NextEpisode = next,
            UpcomingEpisode = upcoming,
            Ended = catalog.Ended,
            AddedAt = entry.AddedAt,
            LastActivityAt = scan.LastActivity,
            Incomplete = scan.Incomplete,
        };
    }

    /// <summary>Status from local watch state only (TMDB unreachable).</summary>
    private static MyListItemDto Offline(ViewerListEntryEntity entry, IReadOnlyList<ViewerWatchStateEntity> states, int? season, bool isNew)
    {
        var scoped = states.Where(s => s.SeasonNumber > 0 && (season is null || s.SeasonNumber == season)).ToList();
        var active = scoped.Any(s => s.Played || s.PositionTicks > 0);
        var last = scoped.Max(s => s.LastPlayedAt);
        return new MyListItemDto
        {
            WorkId = entry.WorkId,
            Kind = entry.Kind,
            TmdbId = entry.TmdbId,
            SeriesWorkId = entry.SeriesWorkId,
            SeasonNumber = entry.SeasonNumber,
            Title = scoped.Select(s => s.Title).FirstOrDefault(t => t is not null)?.Split(" · ")[0] ?? entry.WorkId,
            Status = Override(entry, active ? MyListStatus.Watching : MyListStatus.WantToWatch, last),
            Source = entry.Source,
            IsNew = isNew,
            NewAvailableSince = isNew ? entry.NewAvailableSince : null,
            NewEpisodeWorkId = isNew ? entry.NewEpisodeWorkId : null,
            PlayedEpisodes = scoped.Count(s => s.Played),
            AddedAt = entry.AddedAt,
            LastActivityAt = last,
            Incomplete = true,
        };
    }

    private static CatalogNextEpisodeDto Episode(TmdbMatch series, ListEpisode? episode, int season, int number, string reason, ViewerWatchStateEntity? state) => new()
    {
        WorkId = TvCatalogService.EpisodeWorkId(series.TmdbId, season, number),
        SeasonNumber = season,
        EpisodeNumber = number,
        Title = episode?.Title,
        AirDate = episode?.AirDate,
        StillUrl = episode?.StillUrl,
        RuntimeMinutes = episode?.RuntimeMinutes ?? series.RuntimeMinutes,
        PositionTicks = state?.PositionTicks ?? 0,
        DurationTicks = state?.DurationTicks,
        Reason = reason,
    };

    /// <summary>A viewer-set status holds until playback after it was set.</summary>
    private static string Override(ViewerListEntryEntity entry, string derived, DateTimeOffset? lastActivity)
        => entry is { StatusOverride: { } status, StatusOverrideAt: { } at } && (lastActivity is null || lastActivity <= at) ? status : derived;

    private static bool Allowed(ViewerEntity viewer, ViewerListEntryEntity entry, string? rating, bool lookupFailed)
        => viewer.MaxAge is null
           || ViewerContentPolicy.Decide(viewer, entry.WorkId, rating, ContentRatings.MinimumAge(rating), lookupFailed).Allowed;
}
