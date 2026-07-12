using System.Text;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Newznab search function (the <c>t=</c> parameter): a generic <c>search</c>,
/// a <c>movie</c> search (imdb/tmdb id), or a <c>tvsearch</c> (BRIEF §6.1 module 1).
/// </summary>
public enum NewznabSearchKind
{
    Search,
    Movie,
    Tv,
}

/// <summary>
/// An interface-agnostic Newznab query. The same query is fanned out to every
/// enabled indexer; each <see cref="INewznabClient"/> renders it into that
/// indexer's URL. Never carries an API key — that comes from the indexer config.
/// </summary>
public sealed record NewznabQuery
{
    public NewznabSearchKind Kind { get; init; } = NewznabSearchKind.Search;

    /// <summary>Free-text term (<c>q=</c>). Optional for id-based movie/tv searches.</summary>
    public string? Term { get; init; }

    /// <summary>IMDb id; the leading <c>tt</c> is stripped before it hits the wire.</summary>
    public string? ImdbId { get; init; }

    public int? TmdbId { get; init; }

    public int? Season { get; init; }

    public int? Episode { get; init; }

    /// <summary>Result cap (<c>limit=</c>); null lets the indexer choose its default.</summary>
    public int? Limit { get; init; }

    /// <summary>
    /// Category override (<c>cat=</c>). When empty the indexer's configured
    /// categories are used instead.
    /// </summary>
    public IReadOnlyList<int> Categories { get; init; } = [];

    /// <summary>The <c>t=</c> function name for this query kind.</summary>
    public string Function => Kind switch
    {
        NewznabSearchKind.Movie => "movie",
        NewznabSearchKind.Tv => "tvsearch",
        _ => "search",
    };

    /// <summary>
    /// A stable, whitespace-insensitive key identifying this query independent of
    /// which indexer serves it — used as the search-cache key (BRIEF §6.1).
    /// </summary>
    public string CacheKey()
    {
        var sb = new StringBuilder();
        sb.Append(Function).Append('|');
        sb.Append(NormalizeTerm(Term)).Append('|');
        sb.Append(NormalizeImdb(ImdbId)).Append('|');
        sb.Append(TmdbId?.ToString() ?? string.Empty).Append('|');
        sb.Append(Season?.ToString() ?? string.Empty).Append('|');
        sb.Append(Episode?.ToString() ?? string.Empty).Append('|');
        sb.Append(Limit?.ToString() ?? string.Empty).Append('|');
        sb.Append(string.Join(',', Categories.OrderBy(c => c)));
        return sb.ToString();
    }

    internal static string NormalizeTerm(string? term)
    {
        if (string.IsNullOrWhiteSpace(term))
            return string.Empty;

        var sb = new StringBuilder(term.Length);
        var lastWasSpace = false;
        foreach (var ch in term.Trim())
        {
            if (char.IsLetterOrDigit(ch))
            {
                sb.Append(char.ToLowerInvariant(ch));
                lastWasSpace = false;
            }
            else if (!lastWasSpace)
            {
                sb.Append(' ');
                lastWasSpace = true;
            }
        }

        return sb.ToString().Trim();
    }

    /// <summary>IMDb id with the <c>tt</c> prefix removed, as Newznab expects it.</summary>
    internal static string NormalizeImdb(string? imdbId)
    {
        if (string.IsNullOrWhiteSpace(imdbId))
            return string.Empty;

        var trimmed = imdbId.Trim();
        return trimmed.StartsWith("tt", StringComparison.OrdinalIgnoreCase)
            ? trimmed[2..]
            : trimmed;
    }
}
