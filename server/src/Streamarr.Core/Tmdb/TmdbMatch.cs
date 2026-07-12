using Streamarr.Core.Media;

namespace Streamarr.Core.Tmdb;

/// <summary>
/// A resolved TMDB work — the metadata Streamarr attaches to a <see cref="Work"/>
/// (BRIEF §6.1 module 3). Interface-agnostic: no Jellyfin, no raw TMDB JSON shape.
/// For TV this describes the <em>series</em>; the season/episode identity lives on the
/// work key, not here.
/// </summary>
public sealed record TmdbMatch
{
    public required MediaType MediaType { get; init; }
    public required int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public required string Title { get; init; }
    public int? Year { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }

    /// <summary>Movie runtime, or a series' typical episode runtime, in minutes.</summary>
    public int? RuntimeMinutes { get; init; }
}
