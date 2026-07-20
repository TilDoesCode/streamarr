using Streamarr.Core.Media;
using Streamarr.Core.Search;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Contracts;
using Streamarr.Server.Config;

namespace Streamarr.Server.Services;

/// <summary>
/// Lazy TV hierarchy orchestration. Searching is TMDB-only and capped; opening a series
/// loads season summaries; opening one season performs exactly one cached season-scoped
/// indexer fan-out and distributes its results over the canonical TMDB episode directory.
/// </summary>
public sealed class TvCatalogService(
    ITmdbClient tmdb,
    SearchService searchService,
    GeneralConfigService generalConfig)
{
    public const int MaxSeriesCandidates = 3;

    public async Task<TvSeriesSearchResponse> SearchAsync(
        string query,
        int limit,
        CancellationToken cancellationToken)
    {
        var candidates = await tmdb.SearchCandidatesAsync(query, MediaType.Tv, cancellationToken);
        var addStreamarrBadge = (await generalConfig.GetAsync(cancellationToken)).AddStreamarrBadge;
        return new TvSeriesSearchResponse
        {
            Results = candidates
                .Where(candidate => candidate.MediaType == MediaType.Tv)
                .GroupBy(candidate => candidate.TmdbId)
                .Select(group => group.First())
                .Take(Math.Clamp(limit, 1, MaxSeriesCandidates))
                .Select(candidate => ToSeriesDto(candidate, seasons: null, addStreamarrBadge))
                .ToArray(),
        };
    }

    public async Task<TvSeriesDetailsResponse?> GetSeriesAsync(
        int tmdbId,
        CancellationToken cancellationToken)
    {
        var catalog = await tmdb.GetTvSeriesCatalogAsync(tmdbId, cancellationToken);
        if (catalog is null)
            return null;
        var addStreamarrBadge = (await generalConfig.GetAsync(cancellationToken)).AddStreamarrBadge;
        return ToSeriesDetails(catalog, addStreamarrBadge);
    }

    public async Task<TvSeasonDetailsResponse?> GetSeasonAsync(
        int tmdbId,
        int seasonNumber,
        string? profileId,
        CancellationToken cancellationToken)
    {
        var seriesTask = tmdb.GetTvSeriesCatalogAsync(tmdbId, cancellationToken);
        var seasonTask = tmdb.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, cancellationToken);
        await Task.WhenAll(seriesTask, seasonTask);

        var seriesCatalog = await seriesTask;
        var seasonCatalog = await seasonTask;
        if (seriesCatalog is null || seasonCatalog is null)
            return null;
        var config = await generalConfig.GetAsync(cancellationToken);
        var addStreamarrBadge = config.AddStreamarrBadge;
        var addReleaseScoreToName = config.AddReleaseScoreToName;

        var aggregation = await searchService.SearchAsync(
            new SearchQuery
            {
                Q = seriesCatalog.Series.Title,
                Type = "tv",
                Season = seasonNumber,
                TmdbId = tmdbId,
                ProfileId = profileId,
                ResolvedTarget = seriesCatalog.Series,
            },
            cancellationToken);

        var availableByEpisode = aggregation.Works
            .Where(work => work.MediaType == MediaType.Tv
                           && work.TmdbId == tmdbId
                           && work.Season == seasonNumber
                           && work.Episode is not null)
            .GroupBy(work => work.Episode!.Value)
            .ToDictionary(
                group => group.Key,
                group => group
                    .SelectMany(work => work.Releases)
                    .Where(release => !release.Rejected)
                    .GroupBy(release => release.ReleaseId, StringComparer.Ordinal)
                    .Select(releases => releases.First())
                    .OrderByDescending(release => release.Score)
                    .ThenBy(release => release.Title, StringComparer.OrdinalIgnoreCase)
                    .ToArray());

        var seasonSummary = seriesCatalog.Seasons
            .FirstOrDefault(season => season.SeasonNumber == seasonNumber)
            ?? new TmdbSeasonSummary
            {
                SeasonNumber = seasonNumber,
                Title = seasonCatalog.Title,
                Overview = seasonCatalog.Overview,
                AirDate = seasonCatalog.AirDate,
                PosterUrl = seasonCatalog.PosterUrl,
                EpisodeCount = seasonCatalog.Episodes.Count,
            };

        return new TvSeasonDetailsResponse
        {
            Series = ToSeriesDto(seriesCatalog.Series, seriesCatalog.Seasons, addStreamarrBadge),
            Season = ToSeasonDto(tmdbId, seasonSummary),
            Episodes = seasonCatalog.Episodes.Select(episode => new TvEpisodeDto
            {
                WorkId = EpisodeWorkId(tmdbId, seasonNumber, episode.EpisodeNumber),
                MediaType = "episode",
                TmdbId = tmdbId,
                SeriesTitle = seriesCatalog.Series.Title,
                SeasonNumber = seasonNumber,
                EpisodeNumber = episode.EpisodeNumber,
                Title = episode.Title,
                Overview = episode.Overview,
                AirDate = episode.AirDate,
                RuntimeMinutes = episode.RuntimeMinutes ?? seriesCatalog.Series.RuntimeMinutes,
                StillUrl = episode.StillUrl,
                CommunityRating = episode.CommunityRating,
                People = episode.People,
                AddStreamarrBadge = addStreamarrBadge,
                Releases = availableByEpisode
                    .GetValueOrDefault(episode.EpisodeNumber, [])
                    .Select(release => ToReleaseDto(release, addReleaseScoreToName))
                    .ToArray(),
            }).ToArray(),
            Indexers = aggregation.Outcomes.Select(ToDiagnosticDto).ToArray(),
        };
    }

    private static TvSeriesDetailsResponse ToSeriesDetails(
        TmdbTvSeriesCatalog catalog,
        bool addStreamarrBadge) => new()
    {
        Series = ToSeriesDto(catalog.Series, catalog.Seasons, addStreamarrBadge),
        Seasons = catalog.Seasons.Select(season => ToSeasonDto(catalog.Series.TmdbId, season)).ToArray(),
    };

    private static TvSeriesDto ToSeriesDto(
        TmdbMatch series,
        IReadOnlyList<TmdbSeasonSummary>? seasons,
        bool addStreamarrBadge) => new()
    {
        WorkId = SeriesWorkId(series.TmdbId),
        MediaType = "series",
        Title = series.Title,
        Year = series.Year,
        TmdbId = series.TmdbId,
        ImdbId = series.ImdbId,
        Overview = series.Overview,
        PosterUrl = series.PosterUrl,
        BackdropUrl = series.BackdropUrl,
        RuntimeMinutes = series.RuntimeMinutes,
        SeasonCount = seasons?.Count(season => season.SeasonNumber > 0),
        EpisodeCount = seasons?.Sum(season => season.EpisodeCount),
        OriginalTitle = series.OriginalTitle,
        Tagline = series.Tagline,
        OfficialRating = series.OfficialRating,
        CommunityRating = series.CommunityRating,
        Genres = series.Genres,
        Studios = series.Studios,
        ProductionLocations = series.ProductionLocations,
        People = series.People,
        TrailerUrl = series.TrailerUrl,
        AddStreamarrBadge = addStreamarrBadge,
    };

    private static TvSeasonDto ToSeasonDto(int tmdbId, TmdbSeasonSummary season) => new()
    {
        WorkId = SeasonWorkId(tmdbId, season.SeasonNumber),
        MediaType = "season",
        TmdbId = tmdbId,
        SeasonNumber = season.SeasonNumber,
        Title = season.Title,
        Overview = season.Overview,
        AirDate = season.AirDate,
        PosterUrl = season.PosterUrl,
        EpisodeCount = season.EpisodeCount,
    };

    private static ReleaseDto ToReleaseDto(Release release, bool addScoreToName) => new()
    {
        ReleaseId = release.ReleaseId,
        Title = release.Title,
        Indexer = release.Indexer,
        SizeBytes = release.SizeBytes,
        Quality = new QualityDto
        {
            Resolution = release.Quality.Resolution,
            Source = release.Quality.Source,
            Codec = release.Quality.Codec,
            Hdr = release.Quality.Hdr,
            Audio = release.Quality.Audio,
            Edition = release.Quality.Edition,
            Proper = release.Quality.Proper,
            Repack = release.Quality.Repack,
        },
        Languages = release.Languages,
        ReleaseGroup = release.ReleaseGroup,
        AgeDays = release.AgeDays,
        Grabs = release.Grabs,
        Score = release.Score,
        AddScoreToName = addScoreToName,
        Rejected = release.Rejected,
        RejectionReasons = release.RejectionReasons,
        Health = release.Health.ToString().ToLowerInvariant(),
    };

    private static IndexerDiagnosticDto ToDiagnosticDto(Streamarr.Core.Indexers.IndexerOutcome outcome) => new()
    {
        IndexerId = outcome.IndexerId,
        IndexerName = outcome.IndexerName,
        Status = outcome.Status.ToString().ToLowerInvariant(),
        ItemCount = outcome.ItemCount,
        ElapsedMs = outcome.Elapsed.TotalMilliseconds,
        Error = outcome.Error,
    };

    public static string SeriesWorkId(int tmdbId) => $"tmdb-tv-{tmdbId}";

    public static string SeasonWorkId(int tmdbId, int seasonNumber)
        => $"tmdb-tv-{tmdbId}-s{seasonNumber:D2}";

    public static string EpisodeWorkId(int tmdbId, int seasonNumber, int episodeNumber)
        => $"tmdb-tv-{tmdbId}-s{seasonNumber:D2}e{episodeNumber:D2}";
}
