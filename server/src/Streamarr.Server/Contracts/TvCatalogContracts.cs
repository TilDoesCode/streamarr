namespace Streamarr.Server.Contracts;

/// <summary>TMDB-ranked TV series candidates. The endpoint is intentionally capped at three.</summary>
public sealed record TvSeriesSearchResponse
{
    public required IReadOnlyList<TvSeriesDto> Results { get; init; }
}

/// <summary>A series-level work shown before any season performs an indexer search.</summary>
public sealed record TvSeriesDto
{
    public required string WorkId { get; init; }
    public required string MediaType { get; init; }
    public required string Title { get; init; }
    public int? Year { get; init; }
    public required int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public int? RuntimeMinutes { get; init; }
    public int? SeasonCount { get; init; }
    public int? EpisodeCount { get; init; }
}

/// <summary>A series plus its lazily discoverable season directory.</summary>
public sealed record TvSeriesDetailsResponse
{
    public required TvSeriesDto Series { get; init; }
    public required IReadOnlyList<TvSeasonDto> Seasons { get; init; }
}

public sealed record TvSeasonDto
{
    public required string WorkId { get; init; }
    public required string MediaType { get; init; }
    public required int TmdbId { get; init; }
    public required int SeasonNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    public int EpisodeCount { get; init; }
}

/// <summary>
/// A canonical season directory with accepted releases overlaid per episode. Every TMDB
/// episode remains present even when no accepted release was found.
/// </summary>
public sealed record TvSeasonDetailsResponse
{
    public required TvSeriesDto Series { get; init; }
    public required TvSeasonDto Season { get; init; }
    public required IReadOnlyList<TvEpisodeDto> Episodes { get; init; }
    public required IReadOnlyList<IndexerDiagnosticDto> Indexers { get; init; }
}

public sealed record TvEpisodeDto
{
    public required string WorkId { get; init; }
    public required string MediaType { get; init; }
    public required int TmdbId { get; init; }
    public required string SeriesTitle { get; init; }
    public required int SeasonNumber { get; init; }
    public required int EpisodeNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? StillUrl { get; init; }
    public required IReadOnlyList<ReleaseDto> Releases { get; init; }
}
