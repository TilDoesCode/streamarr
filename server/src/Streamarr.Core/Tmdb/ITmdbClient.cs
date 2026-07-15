using Streamarr.Core.Media;

namespace Streamarr.Core.Tmdb;

/// <summary>
/// Indicates that TMDB did not produce an authoritative hit or miss because the
/// upstream request failed transiently. Cache decorators must not retain the fallback
/// produced for this failure.
/// </summary>
public sealed class TmdbTransientException(string message) : Exception(message);

/// <summary>
/// TMDB metadata lookups (BRIEF §6.1 module 3): search a movie by title+year, a TV
/// series by title, resolve a work by id, and reverse-map an IMDb id. Kept behind an
/// interface so it can be mocked in tests and cached aggressively via a decorator; the
/// real key is supplied from config. Implementations return <c>null</c> when nothing
/// matches (a search miss is not an error), and distinguish transient upstream failures
/// with <see cref="TmdbTransientException"/> so caches cannot retain them as misses.
/// </summary>
public interface ITmdbClient
{
    /// <summary>
    /// Return TMDB's ordered movie/TV candidates for a user-facing discovery query.
    /// Implementations should skip people and preserve TMDB relevance order. The default
    /// implementation keeps existing test/fallback clients compatible by returning their
    /// single best match; the HTTP client overrides it with a real multi-result search.
    /// </summary>
    async Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(
        string query,
        MediaType? mediaType,
        CancellationToken cancellationToken)
    {
        var match = mediaType switch
        {
            MediaType.Movie => await SearchMovieAsync(query, year: null, cancellationToken),
            MediaType.Tv => await SearchTvAsync(query, cancellationToken),
            _ => await SearchAnyAsync(query, cancellationToken),
        };
        return match is null ? [] : [match];
    }

    /// <summary>
    /// Resolve an unconstrained user query to TMDB's best movie or TV match. This uses
    /// TMDB's mixed search ordering, which is important for front-ends such as Jellyfin
    /// whose global search does not necessarily tell Core which media kind the user meant.
    /// </summary>
    Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken);

    Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken);

    Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken);

    Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken);

    Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken);

    /// <summary>Resolve a series and its season summaries without loading episode rows.</summary>
    Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(
        int tmdbId,
        CancellationToken cancellationToken)
        => Task.FromResult<TmdbTvSeriesCatalog?>(null);

    /// <summary>Resolve the canonical episode directory for one season.</summary>
    Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(
        int tmdbId,
        int seasonNumber,
        CancellationToken cancellationToken)
        => Task.FromResult<TmdbTvSeasonCatalog?>(null);

    /// <summary>Resolve a movie or TV work from an IMDb id (<c>tt…</c>).</summary>
    Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken);
}
