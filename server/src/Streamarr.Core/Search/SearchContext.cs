using Streamarr.Core.Media;

namespace Streamarr.Core.Search;

/// <summary>
/// The request-level hints that steer TMDB matching and work aggregation (BRIEF §6.2
/// <c>/search</c> parameters). All optional: with none set the aggregator falls back to
/// per-release parsed titles.
/// </summary>
public sealed record SearchContext
{
    /// <summary>Explicit media type ("movie"/"tv"); null means "any" (infer per release).</summary>
    public MediaType? RequestedType { get; init; }

    public string? ImdbId { get; init; }

    public int? TmdbId { get; init; }

    public int? Season { get; init; }

    public int? Episode { get; init; }

    /// <summary>True when an explicit TMDB or IMDb id was supplied for a targeted match.</summary>
    public bool HasIds => TmdbId is not null || !string.IsNullOrWhiteSpace(ImdbId);

    public static readonly SearchContext Any = new();
}
