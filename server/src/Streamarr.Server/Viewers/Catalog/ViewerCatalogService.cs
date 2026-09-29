using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Controllers;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>A release with its parsed name, as cached for the version lists.</summary>
public sealed record ParsedRelease(Release Release, ParsedReleaseInfo Parsed);

/// <summary>Ranked releases of one movie.</summary>
public sealed record MovieVersions(IReadOnlyList<ParsedRelease> Releases, bool Incomplete);

/// <summary>Ranked releases per episode of one season (season packs merged in).</summary>
public sealed record SeasonVersions(
    IReadOnlyDictionary<int, IReadOnlyList<ParsedRelease>> Episodes,
    IReadOnlyDictionary<int, int?> RuntimeMinutes,
    int EpisodeCount,
    bool Incomplete);

/// <summary>Viewer catalog facade over TMDB, watch state and the search/rank pipeline, with the age policy applied everywhere.</summary>
public sealed class ViewerCatalogService(
    ITmdbClient tmdb,
    WatchStateService watch,
    NextUpService nextUp,
    SearchService search,
    TvCatalogService tv,
    SearchConcurrencyGate searchGate,
    SessionManager sessions,
    IReleaseHealthCache healthCache,
    ViewerVersionCache versionCache,
    PlaybackPredictor predictor,
    TimeProvider time,
    ILogger<ViewerCatalogService> logger)
{
    /// <summary>Client name viewer playback resolves with; local availability is scoped to it and the viewer id.</summary>
    public const string PlaybackClient = WatchStateService.EventSource;

    public const int MaxSearchResults = 20;
    public const int MaxRowItems = 20;

    public async Task<CatalogSearchResponse> SearchAsync(ViewerEntity viewer, string query, MediaType? type, int limit, CancellationToken ct)
    {
        var candidates = await TmdbAsync(() => tmdb.SearchCandidatesAsync(query, type, ct));
        var matches = candidates
            .Where(c => type is null || c.MediaType == type)
            .DistinctBy(c => (c.MediaType, c.TmdbId))
            .Take(MaxSearchResults)
            .ToList();
        var allowed = await AllowedAsync(viewer, matches, ct);
        return new CatalogSearchResponse { Items = allowed.Take(limit).Select(Item).ToList() };
    }

    public async Task<CatalogDiscoverResponse> DiscoverAsync(ViewerEntity viewer, CancellationToken ct)
    {
        (string Id, string Kind, MediaType Type)[] rows =
        [
            ("trending-movies", "trending", MediaType.Movie),
            ("trending-series", "trending", MediaType.Tv),
            ("popular-movies", "popular", MediaType.Movie),
            ("popular-series", "popular", MediaType.Tv),
        ];
        var lists = await Task.WhenAll(rows.Select(row => RowAsync(row.Kind, row.Type, ct)));
        var result = new List<CatalogRowDto>(rows.Length);
        for (var i = 0; i < rows.Length; i++)
        {
            var items = lists[i].Where(m => m.MediaType == rows[i].Type).DistinctBy(m => m.TmdbId).Take(MaxRowItems).ToList();
            var allowed = await AllowedAsync(viewer, items, ct);
            if (allowed.Count == 0)
                continue;
            result.Add(new CatalogRowDto
            {
                Id = rows[i].Id,
                Kind = rows[i].Kind,
                MediaType = MediaTypeName(rows[i].Type),
                Items = allowed.Select(Item).ToList(),
            });
        }
        return new CatalogDiscoverResponse { Rows = result };
    }

    public async Task<CatalogMovieResponse> MovieAsync(ViewerEntity viewer, int tmdbId, CancellationToken ct)
    {
        var movie = await TmdbAsync(() => tmdb.GetMovieAsync(tmdbId, ct)) ?? throw TitleNotFound();
        var key = new WorkKey($"tmdb-movie-{tmdbId}", WorkKind.Movie, tmdbId, null, null);
        var access = Gate(viewer, key.WorkId, movie.OfficialRating);
        var state = (await watch.GetAsync(viewer.Id, [key.WorkId], ct)).FirstOrDefault();
        return new CatalogMovieResponse
        {
            WorkId = key.WorkId,
            TmdbId = tmdbId,
            ImdbId = movie.ImdbId,
            Title = movie.Title,
            OriginalTitle = movie.OriginalTitle,
            Year = movie.Year,
            Overview = movie.Overview,
            Tagline = movie.Tagline,
            Genres = movie.Genres,
            RuntimeMinutes = movie.RuntimeMinutes,
            Certification = movie.OfficialRating,
            VoteAverage = movie.CommunityRating,
            PosterUrl = movie.PosterUrl,
            BackdropUrl = movie.BackdropUrl,
            LogoUrl = movie.LogoUrl,
            TrailerUrl = movie.TrailerUrl,
            People = movie.People,
            Watch = state is null ? ViewerMappings.EmptyState(key) : ViewerMappings.State(state),
            Access = ViewerMappings.Access(access),
        };
    }

    public async Task<CatalogSeriesResponse> SeriesAsync(ViewerEntity viewer, int tmdbId, CancellationToken ct)
    {
        var catalog = await TmdbAsync(() => tmdb.GetTvSeriesCatalogAsync(tmdbId, ct)) ?? throw TitleNotFound();
        var series = catalog.Series;
        var seriesWorkId = TvCatalogService.SeriesWorkId(tmdbId);
        var access = Gate(viewer, seriesWorkId, series.OfficialRating);
        var states = await watch.GetSeriesAsync(viewer.Id, seriesWorkId, ct);
        var regular = catalog.Seasons.Where(s => s.SeasonNumber > 0).ToList();
        var (next, incomplete) = await NextEpisodeAsync(viewer.Id, catalog, states, ct);
        return new CatalogSeriesResponse
        {
            WorkId = seriesWorkId,
            TmdbId = tmdbId,
            ImdbId = series.ImdbId,
            Title = series.Title,
            OriginalTitle = series.OriginalTitle,
            Year = series.Year,
            Overview = series.Overview,
            Tagline = series.Tagline,
            Genres = series.Genres,
            RuntimeMinutes = series.RuntimeMinutes,
            Certification = series.OfficialRating,
            VoteAverage = series.CommunityRating,
            PosterUrl = series.PosterUrl,
            BackdropUrl = series.BackdropUrl,
            LogoUrl = series.LogoUrl,
            TrailerUrl = series.TrailerUrl,
            People = series.People,
            SeasonCount = regular.Count,
            EpisodeCount = regular.Sum(s => s.EpisodeCount),
            Seasons = catalog.Seasons.Select(season => new CatalogSeasonSummaryDto
            {
                WorkId = TvCatalogService.SeasonWorkId(tmdbId, season.SeasonNumber),
                SeasonNumber = season.SeasonNumber,
                Title = season.Title,
                Overview = season.Overview,
                AirDate = season.AirDate,
                PosterUrl = season.PosterUrl,
                EpisodeCount = season.EpisodeCount,
                PlayedCount = states.Count(s => s.SeasonNumber == season.SeasonNumber && s.Played),
                InProgressCount = states.Count(s => s.SeasonNumber == season.SeasonNumber && s.PositionTicks > 0),
            }).ToList(),
            Watch = new SeriesWatchSummaryDto
            {
                PlayedEpisodes = states.Count(s => s.SeasonNumber > 0 && s.Played),
                InProgressEpisodes = states.Count(s => s.SeasonNumber > 0 && s.PositionTicks > 0),
                TotalEpisodes = regular.Sum(s => s.EpisodeCount),
                NextEpisode = next,
                Incomplete = incomplete,
            },
            Access = ViewerMappings.Access(access),
        };
    }

    public async Task<CatalogSeasonResponse> SeasonAsync(
        ViewerEntity viewer, int tmdbId, int seasonNumber, bool availability, bool refresh, CancellationToken ct)
    {
        var seriesTask = TmdbAsync(() => tmdb.GetTvSeriesCatalogAsync(tmdbId, ct));
        var seasonTask = TmdbAsync(() => tmdb.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, ct));
        var catalog = await seriesTask ?? throw TitleNotFound();
        var season = await seasonTask
                     ?? throw ViewerProblem.NotFound("season_not_found", "The season was not found.");
        var seriesWorkId = TvCatalogService.SeriesWorkId(tmdbId);
        Gate(viewer, seriesWorkId, catalog.Series.OfficialRating);

        var states = (await watch.GetSeriesAsync(viewer.Id, seriesWorkId, ct))
            .Where(s => s.SeasonNumber == seasonNumber)
            .ToDictionary(s => s.WorkId, StringComparer.Ordinal);

        CatalogAvailabilityDto? overlay = null;
        SeasonVersions? versions = null;
        if (availability)
        {
            try
            {
                var lookup = await SeasonVersionsAsync(tmdbId, seasonNumber, refresh, ct);
                versions = lookup.Value;
                overlay = new CatalogAvailabilityDto { CheckedAt = lookup.CheckedAt, FromCache = lookup.FromCache, Incomplete = versions.Incomplete };
            }
            catch (ViewerProblem problem) when (problem.Status is StatusCodes.Status429TooManyRequests or StatusCodes.Status503ServiceUnavailable)
            {
                overlay = new CatalogAvailabilityDto { Error = problem.Code };
            }
        }

        var summary = catalog.Seasons.FirstOrDefault(s => s.SeasonNumber == seasonNumber);
        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        return new CatalogSeasonResponse
        {
            SeriesWorkId = seriesWorkId,
            SeriesTitle = catalog.Series.Title,
            WorkId = TvCatalogService.SeasonWorkId(tmdbId, seasonNumber),
            TmdbId = tmdbId,
            SeasonNumber = seasonNumber,
            Title = summary?.Title ?? season.Title,
            Overview = season.Overview ?? summary?.Overview,
            AirDate = season.AirDate ?? summary?.AirDate,
            PosterUrl = season.PosterUrl ?? summary?.PosterUrl,
            Episodes = season.Episodes.Select(episode =>
            {
                var key = WorkKey.ForEpisode(tmdbId, seasonNumber, episode.EpisodeNumber);
                return new CatalogEpisodeDto
                {
                    WorkId = key.WorkId,
                    EpisodeNumber = episode.EpisodeNumber,
                    Title = episode.Title,
                    Overview = episode.Overview,
                    AirDate = episode.AirDate,
                    Aired = NextUpService.HasAired(episode.AirDate, today),
                    RuntimeMinutes = episode.RuntimeMinutes ?? catalog.Series.RuntimeMinutes,
                    StillUrl = episode.StillUrl,
                    VoteAverage = episode.CommunityRating,
                    Watch = states.TryGetValue(key.WorkId, out var state) ? ViewerMappings.State(state) : ViewerMappings.EmptyState(key),
                    VersionCount = versions is null
                        ? null
                        : versions.Episodes.GetValueOrDefault(episode.EpisodeNumber, []).Count(r => !IsDead(r.Release)),
                };
            }).ToList(),
            Availability = overlay,
        };
    }

    public async Task<CatalogVersionsResponse> VersionsAsync(
        ViewerEntity viewer, WorkKey key, bool refresh, DeviceHints? device, CancellationToken ct)
    {
        IReadOnlyList<ParsedRelease> releases;
        int? runtime;
        int packEpisodes;
        DateTimeOffset checkedAt;
        bool fromCache, incomplete;
        switch (key)
        {
            case { Kind: WorkKind.Movie, TmdbId: { } movieId }:
            {
                var movie = await TmdbAsync(() => tmdb.GetMovieAsync(movieId, ct)) ?? throw TitleNotFound();
                Gate(viewer, key.WorkId, movie.OfficialRating);
                var lookup = await versionCache.GetAsync(
                    $"movie:{movieId}", refresh, _ => MovieVersionsAsync(movie, key.WorkId), v => !v.Incomplete, ct);
                (releases, runtime, packEpisodes) = (lookup.Value.Releases, movie.RuntimeMinutes, 1);
                (checkedAt, fromCache, incomplete) = (lookup.CheckedAt, lookup.FromCache, lookup.Value.Incomplete);
                break;
            }
            case { Kind: WorkKind.Episode, TmdbId: { } seriesId, Season: { } seasonNumber, Episode: { } episodeNumber }:
            {
                var catalog = await TmdbAsync(() => tmdb.GetTvSeriesCatalogAsync(seriesId, ct)) ?? throw TitleNotFound();
                Gate(viewer, key.WorkId, catalog.Series.OfficialRating);
                var lookup = await SeasonVersionsAsync(seriesId, seasonNumber, refresh, ct);
                if (!lookup.Value.Episodes.TryGetValue(episodeNumber, out var episodeReleases))
                    throw ViewerProblem.NotFound("episode_not_found", "The episode was not found.");
                (releases, runtime, packEpisodes) = (episodeReleases, lookup.Value.RuntimeMinutes.GetValueOrDefault(episodeNumber), lookup.Value.EpisodeCount);
                (checkedAt, fromCache, incomplete) = (lookup.CheckedAt, lookup.FromCache, lookup.Value.Incomplete);
                break;
            }
            default:
                throw ViewerProblem.BadRequest("invalid_work_id", "Versions are listed for TMDB movie and episode ids only.");
        }

        var local = sessions.ListLocalReleaseAvailability(new HashSet<string>(StringComparer.Ordinal) { key.WorkId }, PlaybackClient, viewer.Id)
            .GroupBy(a => a.ReleaseId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Any(a => a.State == "ready") ? "ready" : "downloading", StringComparer.Ordinal);

        var versions = new List<VersionDto>(releases.Count);
        foreach (var (release, parsed) in releases)
        {
            var health = healthCache.Get(release.ReleaseId) ?? release.Health;
            if (health == ReleaseHealth.Dead)
                continue;
            var estimated = VersionMapper.EstimatedKbps(release.SizeBytes, runtime, VersionMapper.IsSeasonPack(parsed) ? packEpisodes : 1);
            var prediction = device is null ? null : predictor.Predict(parsed, estimated, runtime, device, viewer.AllowTranscoding);
            versions.Add(VersionMapper.Map(release, parsed, versions.Count + 1, health, local.GetValueOrDefault(release.ReleaseId), estimated, prediction));
        }

        return new CatalogVersionsResponse
        {
            WorkId = key.WorkId,
            MediaType = key.Kind == WorkKind.Movie ? "movie" : "episode",
            Versions = versions,
            CheckedAt = checkedAt,
            FromCache = fromCache,
            Incomplete = incomplete,
        };
    }

    private Task<CachedLookup<SeasonVersions>> SeasonVersionsAsync(int tmdbId, int seasonNumber, bool refresh, CancellationToken ct)
        => versionCache.GetAsync($"season:{tmdbId}:{seasonNumber}", refresh, _ => ComputeSeasonAsync(tmdbId, seasonNumber), v => !v.Incomplete, ct);

    private async Task<MovieVersions> MovieVersionsAsync(TmdbMatch movie, string workId)
    {
        using var admission = await searchGate.TryEnterAsync(SearchOperation.ViewerVersions, CancellationToken.None) ?? throw CapacityReached();
        try
        {
            var aggregation = await search.SearchAsync(
                new SearchQuery { Q = movie.Title, Type = "movie", TmdbId = movie.TmdbId },
                admission.CancellationToken);
            if (SearchController.AllIndexersUnavailable(aggregation.Outcomes))
                throw SearchUnavailable("Every configured indexer is temporarily unavailable; retry shortly.");
            var work = aggregation.Works.FirstOrDefault(w => w.WorkId == workId);
            var releases = (work?.Releases ?? []).Where(r => !r.Rejected).Select(Parse).ToList();
            return new MovieVersions(releases, aggregation.Outcomes.Any(o => !o.Succeeded));
        }
        catch (OperationCanceledException) when (admission.DeadlineExceeded)
        {
            throw SearchUnavailable("Search exceeded its server deadline; retry shortly.");
        }
    }

    private async Task<SeasonVersions> ComputeSeasonAsync(int tmdbId, int seasonNumber)
    {
        using var admission = await searchGate.TryEnterAsync(SearchOperation.ViewerVersions, CancellationToken.None) ?? throw CapacityReached();
        try
        {
            var overlay = await tv.GetSeasonReleasesAsync(tmdbId, seasonNumber, profileId: null, admission.CancellationToken)
                          ?? throw ViewerProblem.NotFound("season_not_found", "The season was not found.");
            if (SearchController.AllIndexersUnavailable(overlay.Outcomes))
                throw SearchUnavailable("Every configured indexer is temporarily unavailable; retry shortly.");
            var fallbackRuntime = overlay.Series.Series.RuntimeMinutes;
            return new SeasonVersions(
                overlay.EpisodeReleases.ToDictionary(p => p.Key, p => (IReadOnlyList<ParsedRelease>)p.Value.Select(Parse).ToList()),
                overlay.Season.Episodes.GroupBy(e => e.EpisodeNumber).ToDictionary(g => g.Key, g => g.First().RuntimeMinutes ?? fallbackRuntime),
                overlay.Season.Episodes.Count,
                overlay.Outcomes.Any(o => !o.Succeeded));
        }
        catch (OperationCanceledException) when (admission.DeadlineExceeded)
        {
            throw SearchUnavailable("Search exceeded its server deadline; retry shortly.");
        }
    }

    private async Task<(CatalogNextEpisodeDto? Next, bool Incomplete)> NextEpisodeAsync(
        string viewerId, TmdbTvSeriesCatalog catalog, IReadOnlyList<ViewerWatchStateEntity> states, CancellationToken ct)
    {
        var tmdbId = catalog.Series.TmdbId;
        var next = await nextUp.GetAsync(viewerId, TvCatalogService.SeriesWorkId(tmdbId), 1, ct);
        if (next.Items is [var item, ..])
        {
            return (new CatalogNextEpisodeDto
            {
                WorkId = item.WorkId,
                SeasonNumber = item.SeasonNumber,
                EpisodeNumber = item.EpisodeNumber,
                Title = item.EpisodeTitle,
                AirDate = item.AirDate,
                StillUrl = item.StillUrl,
                RuntimeMinutes = item.RuntimeMinutes ?? catalog.Series.RuntimeMinutes,
                PositionTicks = item.PositionTicks,
                DurationTicks = item.DurationTicks,
                Reason = item.PositionTicks > 0 ? "resume" : "next",
            }, next.Incomplete);
        }

        var resume = states
            .Where(s => s.PositionTicks > 0 && s.SeasonNumber is not null && s.EpisodeNumber is not null)
            .OrderByDescending(s => s.LastPlayedAt)
            .FirstOrDefault();
        if (resume is not null)
        {
            var episode = await EpisodeAsync(tmdbId, resume.SeasonNumber!.Value, resume.EpisodeNumber!.Value, ct);
            return (NextDto(catalog, resume.SeasonNumber.Value, resume.EpisodeNumber.Value, episode, resume.PositionTicks, resume.DurationTicks, "resume")
                    with { Title = episode?.Title ?? resume.Title }, next.Incomplete);
        }

        if (states.Any(s => s.Played))
            return (null, next.Incomplete);

        var first = catalog.Seasons.Where(s => s.SeasonNumber > 0 && s.EpisodeCount > 0).MinBy(s => s.SeasonNumber);
        if (first is null)
            return (null, next.Incomplete);
        try
        {
            var season = await tmdb.GetTvSeasonCatalogAsync(tmdbId, first.SeasonNumber, ct);
            if (season is null)
                return (null, true);
            var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
            var start = season.Episodes.OrderBy(e => e.EpisodeNumber).FirstOrDefault(e => NextUpService.HasAired(e.AirDate, today));
            return (start is null ? null : NextDto(catalog, first.SeasonNumber, start.EpisodeNumber, start, 0, null, "start"), next.Incomplete);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "First-episode lookup for series {TmdbId} failed", tmdbId);
            return (null, true);
        }
    }

    private static CatalogNextEpisodeDto NextDto(
        TmdbTvSeriesCatalog catalog, int season, int episodeNumber, TmdbEpisode? episode, long position, long? duration, string reason) => new()
    {
        WorkId = TvCatalogService.EpisodeWorkId(catalog.Series.TmdbId, season, episodeNumber),
        SeasonNumber = season,
        EpisodeNumber = episodeNumber,
        Title = episode?.Title,
        AirDate = episode?.AirDate,
        StillUrl = episode?.StillUrl,
        RuntimeMinutes = episode?.RuntimeMinutes ?? catalog.Series.RuntimeMinutes,
        PositionTicks = position,
        DurationTicks = duration,
        Reason = reason,
    };

    private async Task<TmdbEpisode?> EpisodeAsync(int tmdbId, int season, int episode, CancellationToken ct)
    {
        try
        {
            return (await tmdb.GetTvSeasonCatalogAsync(tmdbId, season, ct))?.Episodes.FirstOrDefault(e => e.EpisodeNumber == episode);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Episode lookup for series {TmdbId} failed", tmdbId);
            return null;
        }
    }

    /// <summary>List items the viewer may watch, in their original order; restricted viewers need each certification.</summary>
    private async Task<IReadOnlyList<TmdbMatch>> AllowedAsync(ViewerEntity viewer, IReadOnlyList<TmdbMatch> items, CancellationToken ct)
    {
        if (viewer.MaxAge is null || items.Count == 0)
            return items;
        var allowed = await Task.WhenAll(items.Select(item => AllowsAsync(viewer, item, ct)));
        return items.Where((_, i) => allowed[i]).ToList();
    }

    private async Task<bool> AllowsAsync(ViewerEntity viewer, TmdbMatch item, CancellationToken ct)
    {
        var rating = item.OfficialRating;
        var failed = false;
        if (rating is null)
        {
            try
            {
                var details = item.MediaType == MediaType.Movie
                    ? await tmdb.GetMovieAsync(item.TmdbId, ct)
                    : await tmdb.GetTvAsync(item.TmdbId, ct);
                (rating, failed) = (details?.OfficialRating, details is null);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogDebug(e, "Rating lookup for {MediaType} {TmdbId} failed", item.MediaType, item.TmdbId);
                failed = true;
            }
        }
        return ViewerContentPolicy.Decide(viewer, WorkId(item), rating, ContentRatings.MinimumAge(rating), failed).Allowed;
    }

    private static ContentAccessDecision Gate(ViewerEntity viewer, string workId, string? rating)
    {
        var decision = ViewerContentPolicy.Decide(viewer, workId, rating, ContentRatings.MinimumAge(rating), lookupFailed: false);
        if (decision.Allowed)
            return decision;
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal) { ["reason"] = decision.Reason };
        if (decision.Rating is { } r)
            parameters["rating"] = r;
        if (decision.MinimumAge is { } minimum)
            parameters["minimumAge"] = minimum.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (decision.ViewerMaxAge is { } max)
            parameters["viewerMaxAge"] = max.ToString(System.Globalization.CultureInfo.InvariantCulture);
        throw new ViewerProblem(StatusCodes.Status403Forbidden, "age_restricted",
            $"This title is not available for this profile ({decision.Reason}).", parameters);
    }

    private bool IsDead(Release release) => (healthCache.Get(release.ReleaseId) ?? release.Health) == ReleaseHealth.Dead;

    private async Task<IReadOnlyList<TmdbMatch>> RowAsync(string kind, MediaType type, CancellationToken ct)
    {
        try
        {
            return kind == "trending" ? await tmdb.GetTrendingAsync(type, ct) : await tmdb.GetPopularAsync(type, ct);
        }
        catch (TmdbTransientException e)
        {
            logger.LogDebug(e, "TMDB {Kind} {MediaType} list is unavailable", kind, type);
            return [];
        }
    }

    private static async Task<T> TmdbAsync<T>(Func<Task<T>> call)
    {
        try
        {
            return await call();
        }
        catch (TmdbTransientException)
        {
            throw new ViewerProblem(StatusCodes.Status503ServiceUnavailable, "catalog_unavailable", "TMDB is temporarily unavailable; retry shortly.");
        }
    }

    private static ParsedRelease Parse(Release release) => new(release, ReleaseParser.Parse(release.Title));

    private static CatalogItemDto Item(TmdbMatch match) => new()
    {
        WorkId = WorkId(match),
        MediaType = MediaTypeName(match.MediaType),
        TmdbId = match.TmdbId,
        Title = match.Title,
        OriginalTitle = match.OriginalTitle,
        Year = match.Year,
        Overview = match.Overview,
        PosterUrl = match.PosterUrl,
        BackdropUrl = match.BackdropUrl,
        VoteAverage = match.CommunityRating,
    };

    private static string WorkId(TmdbMatch match)
        => match.MediaType == MediaType.Tv ? TvCatalogService.SeriesWorkId(match.TmdbId) : $"tmdb-movie-{match.TmdbId}";

    private static string MediaTypeName(MediaType type) => type == MediaType.Tv ? "series" : "movie";

    private static ViewerProblem TitleNotFound() => ViewerProblem.NotFound("title_not_found", "The title was not found.");

    private static ViewerProblem CapacityReached()
        => new(StatusCodes.Status429TooManyRequests, "capacity_reached", "Search capacity is currently reached; retry shortly.");

    private static ViewerProblem SearchUnavailable(string message)
        => new(StatusCodes.Status503ServiceUnavailable, "search_temporarily_unavailable", message);
}
