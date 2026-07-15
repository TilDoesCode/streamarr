using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;

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

    /// <summary>
    /// Canonical TMDB identity resolved from the user's free-text query before the
    /// indexer search. These hints let the aggregator apply an id only to a title group
    /// that actually resembles the intended work, rather than blindly choosing the
    /// largest group returned by an imperfect indexer.
    /// </summary>
    public string? CanonicalTitle { get; init; }

    public int? CanonicalYear { get; init; }

    /// <summary>
    /// The already-enriched semantic match. Reusing it in aggregation avoids a second
    /// TMDB detail request and guarantees that the work carries the same artwork and
    /// metadata that drove the canonical indexer query.
    /// </summary>
    public TmdbMatch? ResolvedTarget { get; init; }

    /// <summary>
    /// True only when the caller is an internal catalog expansion that already owns the
    /// target identity. Public id searches still have to prove that an indexer title
    /// resembles the resolved TMDB work before that identity may be attached.
    /// </summary>
    public bool ResolvedTargetIsAuthoritative { get; init; }

    /// <summary>
    /// Ordered TMDB discovery candidates for the free-text query. Release-title groups may
    /// attach only to one of these candidates; unrelated substring hits remain unmatched.
    /// </summary>
    public IReadOnlyList<TmdbMatch> SemanticCandidates { get; init; } = [];

    /// <summary>True when an explicit TMDB or IMDb id was supplied for a targeted match.</summary>
    public bool HasIds => TmdbId is not null || !string.IsNullOrWhiteSpace(ImdbId);

    public static readonly SearchContext Any = new();
}
