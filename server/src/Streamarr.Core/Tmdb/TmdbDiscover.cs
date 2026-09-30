using Streamarr.Core.Media;

namespace Streamarr.Core.Tmdb;

/// <summary>Order of a TMDB discover listing.</summary>
public enum TmdbDiscoverSort
{
    Popular,
    TopRated,
    Newest,
}

/// <summary>A browse query: one media type, optionally one TMDB genre, one sort and a 1-based page.</summary>
public sealed record TmdbDiscoverQuery(MediaType MediaType, int? GenreId, TmdbDiscoverSort Sort, int Page)
{
    /// <summary>TMDB serves at most 500 discover pages.</summary>
    public const int MaxPage = 500;
}

/// <summary>One page of TMDB discover results with TMDB's paging totals.</summary>
public sealed record TmdbDiscoverPage(IReadOnlyList<TmdbMatch> Items, int Page, int TotalPages, int TotalResults)
{
    public static readonly TmdbDiscoverPage Empty = new([], 1, 0, 0);
}

/// <summary>A TMDB genre (localized name).</summary>
public sealed record TmdbGenre(int Id, string Name);
