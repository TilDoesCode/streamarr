using System.Collections.Concurrent;
using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.MyList;

/// <summary>Outcome of one monitor pass; for tests and logs.</summary>
public sealed record MyListMonitorPass(int Series, int Lookups, int Flagged, bool IndexersUnavailable);

/// <summary>
/// Flags list entries whose caught-up viewer has a new episode with usable releases (not merely listed on TMDB).
/// Only episodes that aired after the viewer's last played one are searched, each season at most every
/// <see cref="MyListOptions.RecheckMinutes"/>, bounded by a daily cap; a pass where every indexer is down changes nothing.
/// </summary>
public sealed class MyListMonitor(
    IServiceProvider services,
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ITmdbClient tmdb,
    MyListScanner scanner,
    CatalogSpecStore specs,
    ViewerModule module,
    PushoverNotificationService notifications,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<MyListMonitor> logger) : BackgroundService
{
    private readonly MyListOptions _options = options.Value.MyList;
    private readonly ConcurrentDictionary<string, DateTimeOffset> _nextLookup = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _pass = new(1, 1);
    private readonly object _dayLock = new();
    private readonly FailureLog _failures = new(logger);
    private DateOnly _day;
    private int _today;

    /// <summary>The season availability lookup (an indexer search through the viewer version cache); replaceable in tests.</summary>
    internal Func<int, int, CancellationToken, Task> Lookup { get; init; } =
        (tmdbId, season, ct) => services.GetRequiredService<ViewerCatalogService>().RefreshSeasonAvailabilityAsync(tmdbId, season, ct);

    /// <summary>Season lookups started today (UTC).</summary>
    public int LookupsToday
    {
        get
        {
            lock (_dayLock)
                return _day == Today() ? _today : 0;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.MonitorEnabled || _options.IntervalMinutes <= 0)
            return;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(0, _options.StartupDelaySeconds)), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    if (await module.IsEnabledAsync(stoppingToken))
                        await RunOnceAsync(stoppingToken);
                }
                catch (Exception e) when (e is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    _failures.Log(e, "My List monitor pass failed");
                }
                await Task.Delay(TimeSpan.FromMinutes(_options.IntervalMinutes), time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>One pass over every listed series and season.</summary>
    public async Task<MyListMonitorPass> RunOnceAsync(CancellationToken ct)
    {
        await _pass.WaitAsync(ct);
        try
        {
            return await PassAsync(ct);
        }
        finally
        {
            _pass.Release();
        }
    }

    private async Task<MyListMonitorPass> PassAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var finishedCutoff = now.AddDays(-Math.Max(1, _options.FinishedRecheckDays));
        List<ViewerListEntryEntity> entries;
        List<ViewerWatchStateEntity> states;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            entries = await db.ViewerListEntries.AsNoTracking()
                .Where(e => !e.Dismissed && (e.Kind == "series" || e.Kind == "season") && e.SeriesWorkId != null
                            && (e.FinishedCheckedAt == null || e.FinishedCheckedAt < finishedCutoff))
                .ToListAsync(ct);
            var pairs = entries.Select(e => e.ViewerId + "|" + e.SeriesWorkId).ToHashSet(StringComparer.Ordinal);
            var seriesIds = entries.Select(e => e.SeriesWorkId!).Distinct().ToList();
            states = (await db.ViewerWatchStates.AsNoTracking()
                    .Where(s => s.Kind == "episode" && s.SeriesWorkId != null && seriesIds.Contains(s.SeriesWorkId))
                    .ToListAsync(ct))
                .Where(s => pairs.Contains(s.ViewerId + "|" + s.SeriesWorkId))
                .ToList();
        }
        var statesBy = states.GroupBy(s => (s.ViewerId, s.SeriesWorkId!))
            .ToDictionary(g => g.Key, g => (IReadOnlyList<ViewerWatchStateEntity>)g.ToList());

        var updates = new List<EntryUpdate>();
        var waiting = new Dictionary<(int TmdbId, int Season), List<Waiter>>();
        var titles = new Dictionary<int, string>();
        var seriesCount = 0;
        foreach (var group in entries.GroupBy(e => e.TmdbId))
        {
            var withProgress = group.Where(e => statesBy.ContainsKey((e.ViewerId, e.SeriesWorkId!))).ToList();
            if (withProgress.Count == 0)
                continue;
            TmdbTvSeriesCatalog? catalog;
            try
            {
                catalog = await tmdb.GetTvSeriesCatalogAsync(group.Key, ct);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogDebug(e, "My List monitor could not load series {TmdbId}", group.Key);
                continue;
            }
            if (catalog is null)
                continue;
            seriesCount++;
            titles[group.Key] = catalog.Series.Title;

            foreach (var entry in withProgress)
            {
                var scan = await scanner.ScanAsync(catalog, entry.Kind == "season" ? entry.SeasonNumber : null, statesBy[(entry.ViewerId, entry.SeriesWorkId!)], ct);
                if (scan.Anchor is null || scan.Incomplete)
                    continue;
                if (scan.Target is not { } target)
                {
                    if (entry.Kind == "season" || catalog.Ended)
                        updates.Add(new EntryUpdate(entry.Id, Finished: true));
                    continue;
                }
                if (!scan.TargetAired)
                {
                    if (entry.PendingEpisodeWorkId != target.WorkId)
                        updates.Add(new EntryUpdate(entry.Id, Pending: target.WorkId));
                    continue;
                }
                if (!IsCandidate(entry, scan, target))
                    continue;
                var waiter = new Waiter(entry, target);
                if (specs.Available(target.WorkId) == true)
                {
                    updates.Add(Flag(waiter));
                    continue;
                }
                if (!waiting.TryGetValue((group.Key, target.Season), out var list))
                    waiting[(group.Key, target.Season)] = list = [];
                list.Add(waiter);
            }
        }

        var (lookups, unavailable) = await LookupAsync(waiting, updates, now, ct);
        var flagged = await ApplyAsync(updates, now, ct);
        Notify(flagged, titles);
        if (flagged.Count > 0)
            logger.LogInformation("My List monitor flagged {Count} new episode(s)", flagged.Count);
        return new MyListMonitorPass(seriesCount, lookups, flagged.Count, unavailable);
    }

    /// <summary>The viewer was caught up when the target aired (it aired on or after their last played episode), or the monitor saw them wait for it.</summary>
    private static bool IsCandidate(ViewerListEntryEntity entry, SeriesScan scan, ListEpisode target)
    {
        if (entry.LastNotifiedEpisodeWorkId is { } notified && WorkKey.TryParse(notified) is { Season: { } s, Episode: { } e } && !target.After(s, e))
            return false;
        if (entry.PendingEpisodeWorkId == target.WorkId)
            return true;
        var playedAt = scan.Anchor!.PlayedAt ?? scan.Anchor.LastPlayedAt;
        return playedAt is { } at && AirDate(target.AirDate) is { } aired && aired >= DateOnly.FromDateTime(at.UtcDateTime);
    }

    private async Task<(int Lookups, bool Unavailable)> LookupAsync(
        Dictionary<(int TmdbId, int Season), List<Waiter>> waiting, List<EntryUpdate> updates, DateTimeOffset now, CancellationToken ct)
    {
        var lookups = 0;
        var unavailable = false;
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var due = waiting.Where(w => !_nextLookup.TryGetValue(Key(w.Key), out var next) || next <= now).ToList();
        foreach (var (key, waiters) in waiting.Except(due))
            updates.AddRange(waiters.Where(w => w.Entry.PendingEpisodeWorkId != w.Target.WorkId).Select(w => new EntryUpdate(w.Entry.Id, Pending: w.Target.WorkId)));

        try
        {
            await Parallel.ForEachAsync(due, new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(_options.Concurrency, 1, 8), CancellationToken = stop.Token },
                async (pair, token) =>
                {
                    var ((tmdbId, season), waiters) = pair;
                    if (!TryCount())
                        return;
                    Interlocked.Increment(ref lookups);
                    try
                    {
                        await Lookup(tmdbId, season, token);
                    }
                    catch (ViewerProblem e) when (e.Status is StatusCodes.Status503ServiceUnavailable or StatusCodes.Status429TooManyRequests)
                    {
                        // Every indexer down (or search capacity reached): change nothing and try again next pass.
                        unavailable = true;
                        await stop.CancelAsync();
                        return;
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception e)
                    {
                        _failures.Log(e, "My List availability lookup of {TmdbId} season {Season} failed", tmdbId, season);
                    }

                    var latestAir = waiters.Select(w => AirDate(w.Target.AirDate)).Max();
                    var stale = latestAir is { } aired && aired.AddDays(Math.Max(1, _options.StaleAfterDays)) < DateOnly.FromDateTime(now.UtcDateTime);
                    _nextLookup[Key((tmdbId, season))] = now + (stale ? TimeSpan.FromHours(24) : TimeSpan.FromMinutes(Math.Max(1, _options.RecheckMinutes)));
                    lock (updates)
                    {
                        foreach (var waiter in waiters)
                        {
                            if (specs.Available(waiter.Target.WorkId) == true)
                                updates.Add(Flag(waiter));
                            else if (waiter.Entry.PendingEpisodeWorkId != waiter.Target.WorkId)
                                updates.Add(new EntryUpdate(waiter.Entry.Id, Pending: waiter.Target.WorkId));
                        }
                    }
                });
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
        }
        PruneSchedule(now);
        return (lookups, unavailable);
    }

    private async Task<List<Waiter>> ApplyAsync(List<EntryUpdate> updates, DateTimeOffset now, CancellationToken ct)
    {
        var flagged = new List<Waiter>();
        if (updates.Count == 0)
            return flagged;
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var ids = updates.Select(u => u.Id).Distinct().ToList();
        var rows = await db.ViewerListEntries.Where(e => ids.Contains(e.Id)).ToDictionaryAsync(e => e.Id, ct);
        foreach (var update in updates)
        {
            if (!rows.TryGetValue(update.Id, out var row) || row.Dismissed)
                continue;
            if (update.Finished)
                row.FinishedCheckedAt = now;
            if (update.Pending is { } pending)
                row.PendingEpisodeWorkId = pending;
            if (update.NewEpisode is { } waiter && row.NewEpisodeWorkId != waiter.Target.WorkId)
            {
                row.NewAvailableSince = now;
                row.NewEpisodeWorkId = waiter.Target.WorkId;
                row.LastNotifiedEpisodeWorkId = waiter.Target.WorkId;
                row.PendingEpisodeWorkId = null;
                row.SeenAt = null;
                row.FinishedCheckedAt = null;
                flagged.Add(waiter);
            }
            row.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        return flagged;
    }

    private void Notify(List<Waiter> flagged, Dictionary<int, string> titles)
    {
        foreach (var group in flagged.GroupBy(w => w.Target.WorkId))
        {
            var first = group.First();
            var series = titles.GetValueOrDefault(first.Entry.TmdbId) ?? first.Entry.SeriesWorkId ?? first.Target.WorkId;
            var label = string.Create(CultureInfo.InvariantCulture, $"S{first.Target.Season:D2}E{first.Target.Episode:D2}");
            var episodeTitle = string.IsNullOrWhiteSpace(first.Target.Title) ? string.Empty : $" · {first.Target.Title}";
            notifications.Enqueue(new NotificationEvent(
                NotificationEventKind.NewEpisode,
                "New episode available",
                $"{series} {label}{episodeTitle} has usable releases now ({group.Select(w => w.Entry.ViewerId).Distinct().Count()} viewer list(s)).",
                ThrottleKey: group.Key));
        }
    }

    private static EntryUpdate Flag(Waiter waiter) => new(waiter.Entry.Id, NewEpisode: waiter);

    private static string Key((int TmdbId, int Season) key) => $"{key.TmdbId}:{key.Season}";

    private static DateOnly? AirDate(string? value)
        => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) ? date : null;

    private bool TryCount()
    {
        lock (_dayLock)
        {
            var today = Today();
            if (_day != today)
                (_day, _today) = (today, 0);
            if (_today >= _options.DailyCap)
                return false;
            _today++;
            return true;
        }
    }

    private DateOnly Today() => DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);

    private void PruneSchedule(DateTimeOffset now)
    {
        if (_nextLookup.Count < 5_000)
            return;
        foreach (var (key, at) in _nextLookup)
        {
            if (at <= now)
                _nextLookup.TryRemove(key, out _);
        }
    }

    private sealed record Waiter(ViewerListEntryEntity Entry, ListEpisode Target);

    private sealed record EntryUpdate(long Id, bool Finished = false, string? Pending = null, Waiter? NewEpisode = null);
}
