namespace Streamarr.Core.Tmdb;

/// <summary>
/// TMDB metadata lookups (BRIEF §6.1 module 3): search a movie by title+year, a TV
/// series by title, resolve a work by id, and reverse-map an IMDb id. Kept behind an
/// interface so it can be mocked in tests and cached aggressively via a decorator; the
/// real key is supplied from config. Implementations return <c>null</c> when nothing
/// matches (a search miss is not an error) so the pipeline degrades to parsed titles.
/// </summary>
public interface ITmdbClient
{
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

    /// <summary>Resolve a movie or TV work from an IMDb id (<c>tt…</c>).</summary>
    Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken);
}
