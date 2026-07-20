namespace Streamarr.Core.Tmdb;

/// <summary>
/// A TV series plus its lightweight season directory. TMDB includes these summaries in
/// the series detail response, so listing seasons costs one cached metadata request and
/// does not touch an indexer.
/// </summary>
public sealed record TmdbTvSeriesCatalog
{
    public required TmdbMatch Series { get; init; }
    public required IReadOnlyList<TmdbSeasonSummary> Seasons { get; init; }
}

/// <summary>Metadata needed to render one season before its episodes are expanded.</summary>
public sealed record TmdbSeasonSummary
{
    public required int SeasonNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    public int EpisodeCount { get; init; }
}

/// <summary>
/// One lazily loaded season directory. Availability is deliberately not represented here;
/// Core overlays indexer results onto these canonical episode rows at the API boundary.
/// </summary>
public sealed record TmdbTvSeasonCatalog
{
    public required int TmdbId { get; init; }
    public required int SeasonNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    public required IReadOnlyList<TmdbEpisode> Episodes { get; init; }
}

/// <summary>Canonical TMDB metadata for one episode.</summary>
public sealed record TmdbEpisode
{
    public required int EpisodeNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? StillUrl { get; init; }
    public float? CommunityRating { get; init; }
    public IReadOnlyList<TmdbPerson> People { get; init; } = [];
}
