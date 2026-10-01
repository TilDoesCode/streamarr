using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Controllers;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Artwork;
using Streamarr.Server.Viewers.Watch;

using Streamarr.Server.Viewers.Playback;

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
    IPlaybackMedia media,
    IReleaseStore releaseStore,
    ArtworkPaletteService palettes,
    CatalogSpecStore specs,
    ReleaseContainerStore containers,
    SpecWarmupService warmup,
    TimeProvider time,
    ILogger<ViewerCatalogService> logger)
{
    /// <summary>Client name viewer playback resolves with; local availability is scoped to it and the viewer id.</summary>
    public const string PlaybackClient = WatchStateService.EventSource;

    public const int MaxSearchResults = 20;
    public const int MaxRowItems = 20;

    private readonly ITmdbClient _tmdb = tmdb.Strict;

    public async Task<CatalogSearchResponse> SearchAsync(ViewerEntity viewer, string query, MediaType? type, int limit, CancellationToken ct)
    {
        var candidates = await TmdbAsync(() => _tmdb.SearchCandidatesAsync(query, type, ct));
        var matches = candidates
            .Where(c => type is null || c.MediaType == type)
            .DistinctBy(c => (c.MediaType, c.TmdbId))
            .Take(MaxSearchResults)
            .ToList();
        var (allowed, lookupsFailed) = await AllowedAsync(viewer, matches, ct);
        if (allowed.Count == 0 && lookupsFailed)
            throw Unavailable();
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
        var failed = lists.Any(list => list is null);
        for (var i = 0; i < rows.Length; i++)
        {
            var items = (lists[i] ?? []).Where(m => m.MediaType == rows[i].Type).DistinctBy(m => m.TmdbId).Take(MaxRowItems).ToList();
            var (allowed, lookupsFailed) = await AllowedAsync(viewer, items, ct);
            failed |= lookupsFailed;
            if (allowed.Count == 0)
                continue;
            var rowItems = allowed.Select(Item).ToList();
            Warm(rowItems);
            result.Add(new CatalogRowDto
            {
                Id = rows[i].Id,
                Kind = rows[i].Kind,
                MediaType = MediaTypeName(rows[i].Type),
                Items = rowItems,
            });
        }
        if (result.Count == 0 && failed)
            throw Unavailable();
        return new CatalogDiscoverResponse { Rows = result };
    }

    public async Task<CatalogBrowseResponse> BrowseAsync(ViewerEntity viewer, TmdbDiscoverQuery query, CancellationToken ct)
    {
        var page = await TmdbAsync(() => _tmdb.DiscoverAsync(query, ct));
        var items = page.Items.Where(m => m.MediaType == query.MediaType).DistinctBy(m => m.TmdbId).ToList();
        var (allowed, lookupsFailed) = await AllowedAsync(viewer, items, ct);
        if (allowed.Count == 0 && lookupsFailed)
            throw Unavailable();
        var totalPages = Math.Min(page.TotalPages, TmdbDiscoverQuery.MaxPage);
        var pageItems = allowed.Select(Item).ToList();
        Warm(pageItems);
        return new CatalogBrowseResponse
        {
            MediaType = MediaTypeName(query.MediaType),
            Genre = query.GenreId,
            Sort = SortName(query.Sort),
            Page = query.Page,
            TotalPages = totalPages,
            HasMore = query.Page < totalPages,
            Items = pageItems,
        };
    }

    public async Task<CatalogGenresResponse> GenresAsync(MediaType type, CancellationToken ct)
    {
        var genres = await TmdbAsync(() => _tmdb.GetGenresAsync(type, ct));
        return new CatalogGenresResponse
        {
            MediaType = MediaTypeName(type),
            Genres = genres.Select(g => new CatalogGenreDto { Id = g.Id, Name = g.Name }).ToList(),
        };
    }

    public static string SortName(TmdbDiscoverSort sort) => sort switch
    {
        TmdbDiscoverSort.TopRated => "top_rated",
        TmdbDiscoverSort.Newest => "newest",
        _ => "popular",
    };

    public async Task<CatalogMovieResponse> MovieAsync(ViewerEntity viewer, int tmdbId, CancellationToken ct)
    {
        var movie = await TmdbAsync(() => _tmdb.GetMovieAsync(tmdbId, ct)) ?? throw TitleNotFound();
        var key = new WorkKey($"tmdb-movie-{tmdbId}", WorkKind.Movie, tmdbId, null, null);
        var access = Gate(viewer, key.WorkId, movie.OfficialRating);
        var state = (await watch.GetAsync(viewer.Id, [key.WorkId], ct)).FirstOrDefault();
        var palette = palettes.For(movie.BackdropUrl, movie.PosterUrl);
        return new CatalogMovieResponse
        {
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Highlight = palette?.Highlight,
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
        var catalog = await TmdbAsync(() => _tmdb.GetTvSeriesCatalogAsync(tmdbId, ct)) ?? throw TitleNotFound();
        var series = catalog.Series;
        var seriesWorkId = TvCatalogService.SeriesWorkId(tmdbId);
        var access = Gate(viewer, seriesWorkId, series.OfficialRating);
        var states = await watch.GetSeriesAsync(viewer.Id, seriesWorkId, ct);
        var regular = catalog.Seasons.Where(s => s.SeasonNumber > 0).ToList();
        var (next, incomplete) = await NextEpisodeAsync(viewer.Id, catalog, states, ct);
        var palette = palettes.For(series.BackdropUrl, series.PosterUrl);
        return new CatalogSeriesResponse
        {
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Highlight = palette?.Highlight,
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
        var seriesTask = TmdbAsync(() => _tmdb.GetTvSeriesCatalogAsync(tmdbId, ct));
        var seasonTask = TmdbAsync(() => _tmdb.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, ct));
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
        var palette = palettes.For(catalog.Series.BackdropUrl, catalog.Series.PosterUrl);
        return new CatalogSeasonResponse
        {
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Highlight = palette?.Highlight,
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
                    Spec = specs.Get(key.WorkId),
                    VersionCount = versions is null
                        ? null
                        : versions.Episodes.GetValueOrDefault(episode.EpisodeNumber, []).Count(r => !IsDead(r.Release)),
                };
            }).ToList(),
            Availability = overlay,
        };
    }

    public async Task<CatalogVersionsResponse> VersionsAsync(
        ViewerEntity viewer, WorkKey key, bool refresh, DeviceHints? device, CancellationToken ct, DeviceCaps? caps = null)
        => await VersionsAsync(viewer, key, refresh, device, caps is null ? null : new PlayContext(caps, PlaybackPreferences.Default, await media.ServerAsync(ct)), ct);

    private async Task<CatalogVersionsResponse> VersionsAsync(
        ViewerEntity viewer, WorkKey key, bool refresh, DeviceHints? device, PlayContext? play, CancellationToken ct)
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
                var movie = await TmdbAsync(() => _tmdb.GetMovieAsync(movieId, ct)) ?? throw TitleNotFound();
                Gate(viewer, key.WorkId, movie.OfficialRating);
                var lookup = await versionCache.GetAsync(
                    $"movie:{movieId}", refresh, _ => MovieVersionsAsync(movie, key.WorkId), v => !v.Incomplete, ct);
                (releases, runtime, packEpisodes) = (lookup.Value.Releases, movie.RuntimeMinutes, 1);
                specs.Record(key.WorkId, BestSpec(releases));
                (checkedAt, fromCache, incomplete) = (lookup.CheckedAt, lookup.FromCache, lookup.Value.Incomplete);
                break;
            }
            case { Kind: WorkKind.Episode, TmdbId: { } seriesId, Season: { } seasonNumber, Episode: { } episodeNumber }:
            {
                var catalog = await TmdbAsync(() => _tmdb.GetTvSeriesCatalogAsync(seriesId, ct)) ?? throw TitleNotFound();
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

        var versions = MapVersions(viewer, key, releases, runtime, packEpisodes, device, play);
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

    /// <summary>The version a plain "Play" starts on this device (the one marked recommended), searching the indexers when the ranking is not cached.</summary>
    public async Task<VersionDto?> RecommendedAsync(ViewerEntity viewer, WorkKey key, PlayContext? play, CancellationToken ct)
    {
        var versions = (await VersionsAsync(viewer, key, refresh: false, device: null, play, ct)).Versions;
        return versions.FirstOrDefault(v => v.Recommended) ?? versions.FirstOrDefault();
    }

    /// <summary>Remembers the real container of a played version so its prediction matches the playback.</summary>
    public void RecordContainer(string? releaseId, string? container) => containers.Record(releaseId, container);

    /// <summary>One release as a version: ranked from the cached list when present (no indexer search), else from its registration with rank 0.</summary>
    public async Task<VersionDto?> VersionAsync(ViewerEntity viewer, WorkKey key, string releaseId, CancellationToken ct)
    {
        IReadOnlyList<ParsedRelease>? releases = null;
        int? runtime = null;
        var packEpisodes = 1;
        try
        {
            switch (key)
            {
                case { Kind: WorkKind.Movie, TmdbId: { } movieId }:
                    runtime = (await _tmdb.GetMovieAsync(movieId, ct))?.RuntimeMinutes;
                    releases = versionCache.TryPeek<MovieVersions>($"movie:{movieId}")?.Releases;
                    break;
                case { Kind: WorkKind.Episode, TmdbId: { } seriesId, Season: { } season, Episode: { } episode }:
                    if (versionCache.TryPeek<SeasonVersions>($"season:{seriesId}:{season}") is { } cached)
                    {
                        releases = cached.Episodes.GetValueOrDefault(episode);
                        runtime = cached.RuntimeMinutes.GetValueOrDefault(episode);
                        packEpisodes = cached.EpisodeCount;
                    }
                    break;
            }
        }
        catch (TmdbTransientException e)
        {
            logger.LogDebug(e, "Runtime lookup for {WorkId} failed", key.WorkId);
        }

        if (releases is not null && MapVersions(viewer, key, releases, runtime, packEpisodes, null, null).FirstOrDefault(v => v.ReleaseId == releaseId) is { } ranked)
            return ranked;
        if (releaseStore.Get(releaseId, key.WorkId) is not { } registered)
            return null;
        var parsed = ReleaseParser.Parse(registered.Release.Title);
        var local = LocalAvailability(viewer, key);
        var estimated = VersionMapper.EstimatedKbps(registered.Release.SizeBytes, runtime, VersionMapper.IsSeasonPack(parsed) ? packEpisodes : 1);
        return VersionMapper.Map(registered.Release, parsed, 0, healthCache.Get(releaseId) ?? registered.Release.Health,
            local.GetValueOrDefault(releaseId), estimated, null);
    }

    private List<VersionDto> MapVersions(
        ViewerEntity viewer, WorkKey key, IReadOnlyList<ParsedRelease> releases, int? runtime, int packEpisodes, DeviceHints? device, PlayContext? play)
    {
        var local = LocalAvailability(viewer, key);
        var versions = new List<(VersionDto Version, string? Class, int Height)>(releases.Count);
        foreach (var (release, parsed) in releases)
        {
            var health = healthCache.Get(release.ReleaseId) ?? release.Health;
            if (health == ReleaseHealth.Dead)
                continue;
            var estimated = VersionMapper.EstimatedKbps(release.SizeBytes, runtime, VersionMapper.IsSeasonPack(parsed) ? packEpisodes : 1);
            var container = play is null && device is null ? null : containers.Get(release.ReleaseId);
            (string? playClass, PlaybackPrediction? vlcPrediction) = play is null
                ? default
                : predictor.ClassifyAndExplain(parsed, estimated, runtime, play, viewer.AllowTranscoding, container);
            var prediction = device is null ? null : vlcPrediction ?? predictor.Predict(parsed, estimated, runtime, device, viewer.AllowTranscoding, container);
            var version = VersionMapper.Map(release, parsed, versions.Count + 1, health, local.GetValueOrDefault(release.ReleaseId), estimated, prediction);
            versions.Add((version, playClass, VersionMapper.Height(parsed.Resolution)));
        }
        return play is null ? versions.Select(v => v.Version).ToList() : DeviceOrder(versions);
    }

    /// <summary>Best quality that plays without a server transcode first (direct > remux > VLC within a resolution), then transcodes, unplayable last.</summary>
    internal static List<VersionDto> DeviceOrder(IReadOnlyList<(VersionDto Version, string? Class, int Height)> versions)
    {
        static int Group(string? playClass) => playClass is null ? 1 : PlayClass.WithoutTranscode(playClass) ? 0 : playClass == PlayClass.Unplayable ? 2 : 1;
        return versions
            .OrderBy(v => Group(v.Class))
            .ThenByDescending(v => v.Height)
            .ThenBy(v => PlayClass.Order(v.Class ?? PlayClass.Unknown))
            .ThenBy(v => v.Version.QualityRank)
            .Select((v, i) => v.Version with { Rank = i + 1, Recommended = i == 0 && Group(v.Class) < 2 })
            .ToList();
    }

    private Dictionary<string, string> LocalAvailability(ViewerEntity viewer, WorkKey key)
        => sessions.ListLocalReleaseAvailability(new HashSet<string>(StringComparer.Ordinal) { key.WorkId }, PlaybackClient, viewer.Id)
            .GroupBy(a => a.ReleaseId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Any(a => a.State == "ready") ? "ready" : "downloading", StringComparer.Ordinal);

    private async Task<CachedLookup<SeasonVersions>> SeasonVersionsAsync(int tmdbId, int seasonNumber, bool refresh, CancellationToken ct)
    {
        var lookup = await versionCache.GetAsync($"season:{tmdbId}:{seasonNumber}", refresh, _ => ComputeSeasonAsync(tmdbId, seasonNumber), v => !v.Incomplete, ct);
        CatalogSpecDto? seasonBest = null;
        foreach (var (episode, releases) in lookup.Value.Episodes)
        {
            var best = BestSpec(releases);
            specs.Record(WorkKey.ForEpisode(tmdbId, seasonNumber, episode).WorkId, best);
            if (best is not null && (seasonBest is null || CatalogSpecMapper.Score(best) > CatalogSpecMapper.Score(seasonBest)))
                seasonBest = best;
        }
        specs.Record(TvCatalogService.SeasonWorkId(tmdbId, seasonNumber), seasonBest);
        return lookup;
    }

    /// <summary>Spec labels of the first version by quality that is not known dead.</summary>
    private CatalogSpecDto? BestSpec(IReadOnlyList<ParsedRelease> releases)
    {
        foreach (var (release, parsed) in releases)
        {
            var health = healthCache.Get(release.ReleaseId) ?? release.Health;
            if (health != ReleaseHealth.Dead)
                return CatalogSpecMapper.From(VersionMapper.Map(release, parsed, 1, health, null, null, null));
        }
        return null;
    }

    private async Task<MovieVersions> MovieVersionsAsync(TmdbMatch localized, string workId)
    {
        // Indexer queries use the server's metadata language, never the viewer's.
        using var language = TmdbLanguage.Use(null);
        var movie = await DefaultLanguageMovieAsync(localized);
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

    private async Task<TmdbMatch> DefaultLanguageMovieAsync(TmdbMatch localized)
    {
        try
        {
            return await _tmdb.GetMovieAsync(localized.TmdbId, CancellationToken.None) ?? localized;
        }
        catch (TmdbTransientException)
        {
            return localized;
        }
    }

    private async Task<SeasonVersions> ComputeSeasonAsync(int tmdbId, int seasonNumber)
    {
        using var language = TmdbLanguage.Use(null);
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
            var season = await _tmdb.GetTvSeasonCatalogAsync(tmdbId, first.SeasonNumber, ct);
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
            return (await _tmdb.GetTvSeasonCatalogAsync(tmdbId, season, ct))?.Episodes.FirstOrDefault(e => e.EpisodeNumber == episode);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Episode lookup for series {TmdbId} failed", tmdbId);
            return null;
        }
    }

    /// <summary>List items the viewer may watch, in their original order; restricted viewers need each certification, and failed lookups hide the item.</summary>
    private async Task<(IReadOnlyList<TmdbMatch> Allowed, bool LookupsFailed)> AllowedAsync(ViewerEntity viewer, IReadOnlyList<TmdbMatch> items, CancellationToken ct)
    {
        if (viewer.MaxAge is null || items.Count == 0)
            return (items, false);
        var decisions = await Task.WhenAll(items.Select(item => AllowsAsync(viewer, item, ct)));
        return (items.Where((_, i) => decisions[i].Allowed).ToList(), decisions.Any(d => d.Transient));
    }

    private async Task<(bool Allowed, bool Transient)> AllowsAsync(ViewerEntity viewer, TmdbMatch item, CancellationToken ct)
    {
        var rating = item.OfficialRating;
        var failed = false;
        var transient = false;
        if (rating is null)
        {
            try
            {
                var details = item.MediaType == MediaType.Movie
                    ? await _tmdb.GetMovieAsync(item.TmdbId, ct)
                    : await _tmdb.GetTvAsync(item.TmdbId, ct);
                (rating, failed) = (details?.OfficialRating, details is null);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogDebug(e, "Rating lookup for {MediaType} {TmdbId} failed", item.MediaType, item.TmdbId);
                (failed, transient) = (true, e is TmdbTransientException);
            }
        }
        return (ViewerContentPolicy.Decide(viewer, WorkId(item), rating, ContentRatings.MinimumAge(rating), failed).Allowed, transient);
    }

    private static ContentAccessDecision Gate(ViewerEntity viewer, string workId, string? rating)
    {
        var decision = ViewerContentPolicy.Decide(viewer, workId, rating, ContentRatings.MinimumAge(rating), lookupFailed: false);
        return decision.Allowed ? decision : throw ViewerContentPolicy.AgeRestricted(decision);
    }

    private bool IsDead(Release release) => (healthCache.Get(release.ReleaseId) ?? release.Health) == ReleaseHealth.Dead;

    /// <summary>A TMDB list; null when TMDB is unavailable right now.</summary>
    private async Task<IReadOnlyList<TmdbMatch>?> RowAsync(string kind, MediaType type, CancellationToken ct)
    {
        try
        {
            return kind == "trending" ? await _tmdb.GetTrendingAsync(type, ct) : await _tmdb.GetPopularAsync(type, ct);
        }
        catch (TmdbTransientException e)
        {
            logger.LogDebug(e, "TMDB {Kind} {MediaType} list is unavailable", kind, type);
            return null;
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
            throw Unavailable();
        }
    }

    private static ViewerProblem Unavailable() => ViewerProblem.CatalogUnavailable();

    private static ParsedRelease Parse(Release release) => new(release, ReleaseParser.Parse(release.Title));

    private CatalogItemDto Item(TmdbMatch match)
    {
        var palette = palettes.For(match.BackdropUrl, match.PosterUrl);
        return new CatalogItemDto
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
            Tint = palette?.Tint,
            Tint2 = palette?.Tint2,
            Highlight = palette?.Highlight,
            Spec = specs.Get(WorkId(match)),
        };
    }

    private void Warm(IEnumerable<CatalogItemDto> items) => warmup.Request(items.Where(i => i.Spec is null).Select(i => i.WorkId));

    /// <summary>Background spec lookup (spec warm-up): the cached or searched versions of a movie or season, recorded in the spec store.</summary>
    internal async Task WarmSpecAsync(SpecWarmupTarget target, CancellationToken ct)
    {
        using var language = TmdbLanguage.Use(null);
        if (target.Movie)
        {
            if (await _tmdb.GetMovieAsync(target.TmdbId, ct) is not { } movie)
                return;
            var workId = $"tmdb-movie-{target.TmdbId}";
            var lookup = await versionCache.GetAsync($"movie:{target.TmdbId}", false, _ => MovieVersionsAsync(movie, workId), v => !v.Incomplete, ct);
            specs.Record(workId, BestSpec(lookup.Value.Releases));
            return;
        }
        var season = target.Season;
        if (season is null)
        {
            var seasons = (await _tmdb.GetTvSeriesCatalogAsync(target.TmdbId, ct))?.Seasons ?? [];
            season = seasons.Where(s => s.SeasonNumber > 0 && s.EpisodeCount > 0).Select(s => (int?)s.SeasonNumber).Min();
            if (season is null)
                return;
        }
        await SeasonVersionsAsync(target.TmdbId, season.Value, false, ct);
    }

    private static string WorkId(TmdbMatch match)
        => match.MediaType == MediaType.Tv ? TvCatalogService.SeriesWorkId(match.TmdbId) : $"tmdb-movie-{match.TmdbId}";

    private static string MediaTypeName(MediaType type) => type == MediaType.Tv ? "series" : "movie";

    private static ViewerProblem TitleNotFound() => ViewerProblem.NotFound("title_not_found", "The title was not found.");

    private static ViewerProblem CapacityReached()
        => new(StatusCodes.Status429TooManyRequests, "capacity_reached", "Search capacity is currently reached; retry shortly.");

    private static ViewerProblem SearchUnavailable(string message)
        => new(StatusCodes.Status503ServiceUnavailable, "search_temporarily_unavailable", message);
}
