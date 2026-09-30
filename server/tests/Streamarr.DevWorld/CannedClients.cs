using System.Globalization;
using System.Text;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;

namespace Streamarr.DevWorld;

/// <summary>Newznab fixture: answers movie/tv/search queries from the published fixture releases.</summary>
public sealed class CannedNewznabClient(IReadOnlyList<PublishedRelease> releases, DateTimeOffset now) : INewznabClient
{
    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabCapabilities
        {
            ServerTitle = "Streamarr Dev World indexer",
            ServerVersion = "1.0",
            LimitMax = 100,
            LimitDefault = 100,
            SearchAvailable = true,
            MovieSearchAvailable = true,
            TvSearchAvailable = true,
            Categories =
            [
                new NewznabCategory { Id = 2000, Name = "Movies", Subcategories = [new NewznabCategory { Id = 2040, Name = "Movies/HD" }, new NewznabCategory { Id = 2045, Name = "Movies/UHD" }, new NewznabCategory { Id = 2030, Name = "Movies/SD" }] },
                new NewznabCategory { Id = 5000, Name = "TV", Subcategories = [new NewznabCategory { Id = 5040, Name = "TV/HD" }, new NewznabCategory { Id = 5030, Name = "TV/SD" }] },
            ],
        });

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        var items = Match(query)
            .Take(query.Limit is > 0 ? query.Limit.Value : 100)
            .Select(ToItem)
            .ToArray();
        return Task.FromResult(new NewznabSearchResponse { Items = items, Total = items.Length });
    }

    private IEnumerable<PublishedRelease> Match(NewznabQuery query)
    {
        IEnumerable<PublishedRelease> result = releases;
        result = query.Kind switch
        {
            NewznabSearchKind.Movie => result.Where(r => r.Plan.MediaType == "movie"),
            NewznabSearchKind.Tv => result.Where(r => r.Plan.MediaType == "tv"),
            _ => result,
        };
        if (query.TmdbId is { } tmdbId)
            result = result.Where(r => r.Plan.Title.TmdbId == tmdbId);
        else if (!string.IsNullOrWhiteSpace(query.ImdbId))
            result = result.Where(r => string.Equals(Imdb(r.Plan.Title.ImdbId), Imdb(query.ImdbId), StringComparison.OrdinalIgnoreCase));

        if (!string.IsNullOrWhiteSpace(query.Term))
        {
            var tokens = Text.Tokens(query.Term);
            result = result.Where(r =>
            {
                var haystack = Text.Tokens(r.Plan.Name).Concat(Text.Tokens(r.Plan.Title.Title)).ToHashSet(StringComparer.Ordinal);
                return tokens.All(haystack.Contains);
            });
        }

        if (query.Season is { } season)
            result = result.Where(r => r.Plan.Season == season);
        if (query.Episode is { } episode)
            result = result.Where(r => r.Plan.Episode == episode || r.Plan.IsSeasonPack);
        return result;
    }

    private NewznabItem ToItem(PublishedRelease release)
    {
        var plan = release.Plan;
        var height = plan.Files[0].Media.Variant.Video.Height;
        var category = plan.MediaType == "movie"
            ? height >= 2160 ? 2045 : height >= 720 ? 2040 : 2030
            : height >= 720 ? 5040 : 5030;
        var posted = now.AddDays(-plan.Entry.AgeDays).AddHours(-3);
        return new NewznabItem
        {
            Title = plan.Name,
            Guid = plan.Guid,
            NzbUrl = release.NzbPath,
            SizeBytes = plan.ReportedSizeBytes,
            Categories = [category, category / 1000 * 1000],
            Grabs = plan.Entry.Grabs,
            PublishDate = posted,
            UsenetDate = posted,
        };
    }

    private static string? Imdb(string? value) => value?.Trim().TrimStart('t', 'T');
}

/// <summary>TMDB fixture: search, details and the TV season directory from the catalog.</summary>
public sealed class CannedTmdbClient(DevCatalog catalog) : ITmdbClient
{
    public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(string query, MediaType? mediaType, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<TmdbMatch>>(Candidates(query, mediaType).ToList());

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => Task.FromResult(Candidates(query, null).FirstOrDefault());

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => Task.FromResult(Candidates(title, MediaType.Movie).OrderByDescending(m => m.Year == year).FirstOrDefault());

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Task.FromResult(Candidates(title, MediaType.Tv).FirstOrDefault());

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(catalog.Movies.FirstOrDefault(m => m.TmdbId == tmdbId) is { } movie ? ToMatch(movie, MediaType.Movie) : null);

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(catalog.Series.FirstOrDefault(s => s.TmdbId == tmdbId) is { } series ? ToMatch(series, MediaType.Tv) : null);

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
    {
        var series = catalog.Series.FirstOrDefault(s => s.TmdbId == tmdbId);
        return Task.FromResult(series is null
            ? null
            : new TmdbTvSeriesCatalog
            {
                Series = ToMatch(series, MediaType.Tv),
                Seasons = series.Seasons.Select(season => new TmdbSeasonSummary
                {
                    SeasonNumber = season.SeasonNumber,
                    Title = season.Title,
                    AirDate = season.Episodes.FirstOrDefault()?.AirDate,
                    PosterUrl = season.PosterUrl,
                    EpisodeCount = season.Episodes.Count,
                }).ToList(),
            });
    }

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
    {
        var season = catalog.Series.FirstOrDefault(s => s.TmdbId == tmdbId)?.Seasons.FirstOrDefault(s => s.SeasonNumber == seasonNumber);
        return Task.FromResult(season is null
            ? null
            : new TmdbTvSeasonCatalog
            {
                TmdbId = tmdbId,
                SeasonNumber = seasonNumber,
                Title = season.Title,
                AirDate = season.Episodes.FirstOrDefault()?.AirDate,
                PosterUrl = season.PosterUrl,
                Episodes = season.Episodes.Select(e => new TmdbEpisode
                {
                    EpisodeNumber = e.EpisodeNumber,
                    Title = e.Title,
                    Overview = e.Overview,
                    AirDate = e.AirDate,
                    RuntimeMinutes = e.RuntimeMinutes,
                    StillUrl = e.StillUrl,
                }).ToList(),
            });
    }

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
    {
        var movie = catalog.Movies.FirstOrDefault(m => string.Equals(m.ImdbId, imdbId, StringComparison.OrdinalIgnoreCase));
        if (movie is not null)
            return Task.FromResult<TmdbMatch?>(ToMatch(movie, MediaType.Movie));
        var series = catalog.Series.FirstOrDefault(s => string.Equals(s.ImdbId, imdbId, StringComparison.OrdinalIgnoreCase));
        return Task.FromResult(series is null ? null : ToMatch(series, MediaType.Tv));
    }

    public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Task.FromResult(List(mediaType == MediaType.Movie ? catalog.Discover.TrendingMovies : catalog.Discover.TrendingSeries, mediaType));

    public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Task.FromResult(List(mediaType == MediaType.Movie ? catalog.Discover.PopularMovies : catalog.Discover.PopularSeries, mediaType));

    /// <summary>Small pages so paging is testable with the few fixture titles.</summary>
    public const int DiscoverPageSize = 4;

    /// <summary>TMDB's genre ids by English name (movie and tv lists share the common ones).</summary>
    public static readonly IReadOnlyDictionary<string, int> GenreIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
    {
        ["Action"] = 28, ["Adventure"] = 12, ["Animation"] = 16, ["Comedy"] = 35, ["Crime"] = 80, ["Documentary"] = 99,
        ["Drama"] = 18, ["Family"] = 10751, ["Fantasy"] = 14, ["History"] = 36, ["Horror"] = 27, ["Music"] = 10402,
        ["Mystery"] = 9648, ["Romance"] = 10749, ["Science Fiction"] = 878, ["TV Movie"] = 10770, ["Thriller"] = 53,
        ["War"] = 10752, ["Western"] = 37, ["Action & Adventure"] = 10759, ["Kids"] = 10762, ["News"] = 10763,
        ["Reality"] = 10764, ["Sci-Fi & Fantasy"] = 10765, ["Soap"] = 10766, ["Talk"] = 10767, ["War & Politics"] = 10768,
    };

    public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
    {
        var titles = Titles(query.MediaType)
            .Where(t => query.GenreId is not { } genre || t.Genres.Any(name => GenreIds.GetValueOrDefault(name) == genre));
        var sorted = query.Sort switch
        {
            TmdbDiscoverSort.TopRated => titles.OrderByDescending(t => t.CommunityRating ?? 0),
            TmdbDiscoverSort.Newest => titles.OrderByDescending(t => t.Year ?? 0),
            _ => titles.OrderBy(t => Popularity(t, query.MediaType)),
        };
        var all = sorted.ThenBy(t => t.TmdbId).Select(t => t.Key).ToList();
        var totalPages = (all.Count + DiscoverPageSize - 1) / DiscoverPageSize;
        var page = all.Skip((query.Page - 1) * DiscoverPageSize).Take(DiscoverPageSize);
        return Task.FromResult(new TmdbDiscoverPage(List(page, query.MediaType), query.Page, totalPages, all.Count));
    }

    public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<TmdbGenre>>(Titles(mediaType)
            .SelectMany(t => t.Genres)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Where(GenreIds.ContainsKey)
            .Select(name => new TmdbGenre(GenreIds[name], name))
            .OrderBy(g => g.Name, StringComparer.Ordinal)
            .ToList());

    private IEnumerable<TitleEntry> Titles(MediaType type)
        => type == MediaType.Movie ? catalog.Movies : catalog.Series;

    /// <summary>Position in the popular row, then the trending row; titles in neither come last.</summary>
    private int Popularity(TitleEntry title, MediaType type)
    {
        var popular = type == MediaType.Movie ? catalog.Discover.PopularMovies : catalog.Discover.PopularSeries;
        var trending = type == MediaType.Movie ? catalog.Discover.TrendingMovies : catalog.Discover.TrendingSeries;
        var index = popular.IndexOf(title.Key);
        if (index >= 0)
            return index;
        index = trending.IndexOf(title.Key);
        return index >= 0 ? 1_000 + index : int.MaxValue;
    }

    /// <summary>Like TMDB list results: card fields only, so certifications need a detail lookup.</summary>
    private IReadOnlyList<TmdbMatch> List(IEnumerable<string> keys, MediaType type)
        => keys
            .Select(key => type == MediaType.Movie
                ? (TitleEntry?)catalog.Movies.FirstOrDefault(m => m.Key == key)
                : catalog.Series.FirstOrDefault(s => s.Key == key))
            .OfType<TitleEntry>()
            .Select(entry => ToMatch(entry, type) with
            {
                ImdbId = null,
                Tagline = null,
                OfficialRating = null,
                LogoUrl = null,
                Genres = [],
                RuntimeMinutes = null,
            })
            .ToList();

    /// <summary>Exact title first, then prefix, then token matches; ties by community rating.</summary>
    private IEnumerable<TmdbMatch> Candidates(string query, MediaType? mediaType)
    {
        var queryTokens = Text.Tokens(query);
        if (queryTokens.Length == 0)
            return [];
        var q = string.Join(' ', queryTokens);
        var titles = catalog.Movies.Select(m => (Entry: (TitleEntry)m, Type: MediaType.Movie))
            .Concat(catalog.Series.Select(s => (Entry: (TitleEntry)s, Type: MediaType.Tv)))
            .Where(t => mediaType is null || t.Type == mediaType);

        return titles
            .Select(t =>
            {
                var names = new[] { t.Entry.Title, t.Entry.TitleDe, t.Entry.OriginalTitle }
                    .Where(n => !string.IsNullOrWhiteSpace(n))
                    .Select(n => string.Join(' ', Text.Tokens(n!)))
                    .ToList();
                var score = names.Any(n => n == q) ? 3
                    : names.Any(n => n.StartsWith(q, StringComparison.Ordinal)) ? 2
                    : names.Any(n => queryTokens.All(n.Split(' ').Contains)) ? 1
                    : 0;
                return (t.Entry, t.Type, Score: score);
            })
            .Where(t => t.Score > 0)
            .OrderByDescending(t => t.Score)
            .ThenByDescending(t => t.Entry.CommunityRating ?? 0)
            .Select(t => ToMatch(t.Entry, t.Type));
    }

    private static TmdbMatch ToMatch(TitleEntry entry, MediaType type) => new()
    {
        MediaType = type,
        TmdbId = entry.TmdbId,
        ImdbId = entry.ImdbId,
        Title = entry.Title,
        Year = entry.Year,
        Overview = entry.Overview,
        PosterUrl = entry.PosterUrl,
        BackdropUrl = entry.BackdropUrl,
        LogoUrl = entry.LogoUrl,
        OriginalTitle = entry.OriginalTitle,
        Tagline = entry.Tagline,
        OfficialRating = entry.OfficialRating,
        CommunityRating = entry.CommunityRating,
        Genres = entry.Genres,
        RuntimeMinutes = entry.RuntimeMinutes,
    };
}

internal static class Text
{
    /// <summary>Lower-case alphanumeric tokens (diacritics folded), like Newznab term matching.</summary>
    public static string[] Tokens(string value)
    {
        var folded = new string(value.Normalize(NormalizationForm.FormD)
            .Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            .Select(c => char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : ' ')
            .ToArray());
        return folded.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    }
}
