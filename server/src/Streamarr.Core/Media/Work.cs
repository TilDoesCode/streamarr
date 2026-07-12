namespace Streamarr.Core.Media;

public enum MediaType
{
    Movie,
    Tv,
}

/// <summary>
/// A "work" is one movie or one episode, aggregating N alternative releases.
/// Front-ends show one item per work with releases as selectable versions
/// (BRIEF.md §7.4). This is the unit returned by /api/v1/search.
/// </summary>
public sealed record Work
{
    /// <summary>Stable id, e.g. "tmdb-movie-12345" or "tmdb-tv-456-s01e02".</summary>
    public required string WorkId { get; init; }

    public required MediaType MediaType { get; init; }
    public required string Title { get; init; }
    public int? Year { get; init; }

    public int? TmdbId { get; init; }
    public string? ImdbId { get; init; }

    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public int? RuntimeMinutes { get; init; }

    /// <summary>For TV works.</summary>
    public int? Season { get; init; }
    public int? Episode { get; init; }

    /// <summary>Ranked releases, best first.</summary>
    public IReadOnlyList<Release> Releases { get; init; } = [];
}
