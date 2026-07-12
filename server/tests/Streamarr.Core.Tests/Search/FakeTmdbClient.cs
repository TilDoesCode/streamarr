using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Search;

/// <summary>
/// Scriptable <see cref="ITmdbClient"/> for aggregator tests: hand it delegates for
/// each lookup and it counts the calls, so tests can assert TMDB is queried once per
/// distinct work rather than once per release.
/// </summary>
internal sealed class FakeTmdbClient : ITmdbClient
{
    public Func<string, int?, TmdbMatch?> OnSearchMovie { get; set; } = (_, _) => null;
    public Func<string, TmdbMatch?> OnSearchTv { get; set; } = _ => null;
    public Func<int, TmdbMatch?> OnGetMovie { get; set; } = _ => null;
    public Func<int, TmdbMatch?> OnGetTv { get; set; } = _ => null;
    public Func<string, TmdbMatch?> OnFindByImdb { get; set; } = _ => null;

    public int SearchMovieCalls { get; private set; }
    public int SearchTvCalls { get; private set; }
    public int GetMovieCalls { get; private set; }
    public int GetTvCalls { get; private set; }
    public int FindByImdbCalls { get; private set; }

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
    {
        SearchMovieCalls++;
        return Task.FromResult(OnSearchMovie(title, year));
    }

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
    {
        SearchTvCalls++;
        return Task.FromResult(OnSearchTv(title));
    }

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
    {
        GetMovieCalls++;
        return Task.FromResult(OnGetMovie(tmdbId));
    }

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
    {
        GetTvCalls++;
        return Task.FromResult(OnGetTv(tmdbId));
    }

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
    {
        FindByImdbCalls++;
        return Task.FromResult(OnFindByImdb(imdbId));
    }

    public static TmdbMatch Movie(int id, string title, int? year = null, int? runtime = null, string? imdbId = null) => new()
    {
        MediaType = MediaType.Movie,
        TmdbId = id,
        Title = title,
        Year = year,
        RuntimeMinutes = runtime,
        ImdbId = imdbId,
        PosterUrl = $"https://image.example/poster/{id}.jpg",
        Overview = "An example work.",
    };

    public static TmdbMatch Tv(int id, string title, int? year = null, int? runtime = null, string? imdbId = null) => new()
    {
        MediaType = MediaType.Tv,
        TmdbId = id,
        Title = title,
        Year = year,
        RuntimeMinutes = runtime,
        ImdbId = imdbId,
    };
}
