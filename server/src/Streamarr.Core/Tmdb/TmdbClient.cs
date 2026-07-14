using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;

namespace Streamarr.Core.Tmdb;

/// <summary>
/// Default <see cref="ITmdbClient"/> over <see cref="HttpClient"/> against the TMDB v3
/// REST API (BRIEF §6.1 module 3). A search resolves an id, then the detail endpoint is
/// fetched to enrich runtime + IMDb id + artwork. Stateless; wrap in
/// <see cref="CachingTmdbClient"/> for aggressive caching. With no configured API key
/// every method returns <c>null</c> so the search pipeline still functions.
/// </summary>
public sealed class TmdbClient(HttpClient httpClient, TmdbOptions options, ILogger<TmdbClient>? logger = null) : ITmdbClient
{
    private readonly ILogger _logger = logger ?? NullLogger<TmdbClient>.Instance;

    private bool HasKey => !string.IsNullOrWhiteSpace(options.ApiKey);

    public async Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
    {
        if (!HasKey || string.IsNullOrWhiteSpace(query))
            return null;

        using var doc = await GetAsync($"search/multi?query={Uri.EscapeDataString(query)}", cancellationToken);
        var result = FirstMediaResult(doc);
        return result switch
        {
            { Type: MediaType.Movie, Id: var id } => await GetMovieAsync(id, cancellationToken),
            { Type: MediaType.Tv, Id: var id } => await GetTvAsync(id, cancellationToken),
            _ => null,
        };
    }

    public async Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
    {
        if (!HasKey || string.IsNullOrWhiteSpace(title))
            return null;

        var query = new StringBuilder("search/movie?query=").Append(Uri.EscapeDataString(title));
        if (year is { } y)
            query.Append("&primary_release_year=").Append(y.ToString(CultureInfo.InvariantCulture));

        using var doc = await GetAsync(query.ToString(), cancellationToken);
        var id = FirstResultId(doc);
        return id is { } tmdbId ? await GetMovieAsync(tmdbId, cancellationToken) : null;
    }

    public async Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
    {
        if (!HasKey || string.IsNullOrWhiteSpace(title))
            return null;

        using var doc = await GetAsync($"search/tv?query={Uri.EscapeDataString(title)}", cancellationToken);
        var id = FirstResultId(doc);
        return id is { } tmdbId ? await GetTvAsync(tmdbId, cancellationToken) : null;
    }

    public async Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (!HasKey || tmdbId <= 0)
            return null;

        using var doc = await GetAsync($"movie/{tmdbId}", cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        return new TmdbMatch
        {
            MediaType = MediaType.Movie,
            TmdbId = tmdbId,
            ImdbId = NullIfEmpty(GetBoundedString(root, "imdb_id", 32)),
            Title = GetBoundedString(root, "title", 512) ??
                    GetBoundedString(root, "original_title", 512) ?? $"Movie {tmdbId}",
            Year = YearOf(GetBoundedString(root, "release_date", 32)),
            Overview = NullIfEmpty(GetBoundedString(root, "overview", 8_192)),
            PosterUrl = Image(GetBoundedString(root, "poster_path", 1_024), options.PosterSize),
            BackdropUrl = Image(GetBoundedString(root, "backdrop_path", 1_024), options.BackdropSize),
            RuntimeMinutes = RuntimeOrNull(GetInt(root, "runtime")),
        };
    }

    public async Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (!HasKey || tmdbId <= 0)
            return null;

        using var doc = await GetAsync($"tv/{tmdbId}?append_to_response=external_ids", cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        return new TmdbMatch
        {
            MediaType = MediaType.Tv,
            TmdbId = tmdbId,
            ImdbId = ExternalImdbId(root),
            Title = GetBoundedString(root, "name", 512) ??
                    GetBoundedString(root, "original_name", 512) ?? $"Series {tmdbId}",
            Year = YearOf(GetBoundedString(root, "first_air_date", 32)),
            Overview = NullIfEmpty(GetBoundedString(root, "overview", 8_192)),
            PosterUrl = Image(GetBoundedString(root, "poster_path", 1_024), options.PosterSize),
            BackdropUrl = Image(GetBoundedString(root, "backdrop_path", 1_024), options.BackdropSize),
            RuntimeMinutes = FirstEpisodeRuntime(root),
        };
    }

    public async Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
    {
        if (!HasKey || string.IsNullOrWhiteSpace(imdbId))
            return null;

        var id = imdbId.Trim();
        using var doc = await GetAsync($"find/{Uri.EscapeDataString(id)}?external_source=imdb_id", cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        if (root.TryGetProperty("movie_results", out var movies) && movies.ValueKind == JsonValueKind.Array && movies.GetArrayLength() > 0)
        {
            var tmdbId = PositiveIdOrNull(GetInt(movies[0], "id"));
            return tmdbId is { } m ? await GetMovieAsync(m, cancellationToken) : null;
        }

        if (root.TryGetProperty("tv_results", out var shows) && shows.ValueKind == JsonValueKind.Array && shows.GetArrayLength() > 0)
        {
            var tmdbId = PositiveIdOrNull(GetInt(shows[0], "id"));
            return tmdbId is { } t ? await GetTvAsync(t, cancellationToken) : null;
        }

        return null;
    }

    private async Task<JsonDocument?> GetAsync(string relativeUrl, CancellationToken cancellationToken)
    {
        var url = BuildUrl(relativeUrl);
        var route = relativeUrl.Split('?', 2)[0];
        try
        {
            using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("TMDB {Route} returned HTTP {Status}", route, (int)response.StatusCode);
                return null;
            }

            if (response.Content.Headers.ContentLength is { } length && length > options.MaxResponseBytes)
            {
                _logger.LogWarning("TMDB {Route} response exceeded the configured size limit", route);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var bounded = new MemoryStream(Math.Min(options.MaxResponseBytes, 64 * 1024));
            var buffer = new byte[64 * 1024];
            var total = 0;
            while (true)
            {
                var remaining = options.MaxResponseBytes - total;
                var read = await stream.ReadAsync(
                    buffer.AsMemory(0, Math.Min(buffer.Length, remaining + 1)),
                    cancellationToken);
                if (read == 0)
                    break;
                total += read;
                if (total > options.MaxResponseBytes)
                {
                    _logger.LogWarning("TMDB {Route} response exceeded the configured size limit", route);
                    return null;
                }
                await bounded.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }

            bounded.Position = 0;
            return await JsonDocument.ParseAsync(bounded, cancellationToken: cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or IOException or OperationCanceledException)
        {
            // Do not attach the HttpRequestException: some handlers include the full URI, which
            // carries the TMDB API key in its query string.
            _logger.LogWarning("TMDB request {Route} failed ({ErrorType})", route, e.GetType().Name);
            return null;
        }
    }

    private Uri BuildUrl(string relativeUrl)
    {
        var baseUrl = options.BaseUrl.TrimEnd('/');
        var separator = relativeUrl.Contains('?') ? '&' : '?';
        var sb = new StringBuilder(baseUrl).Append('/').Append(relativeUrl)
            .Append(separator).Append("api_key=").Append(Uri.EscapeDataString(options.ApiKey));
        if (!string.IsNullOrWhiteSpace(options.Language))
            sb.Append("&language=").Append(Uri.EscapeDataString(options.Language));
        return new Uri(sb.ToString(), UriKind.Absolute);
    }

    private static int? FirstResultId(JsonDocument? doc)
    {
        if (doc is null)
            return null;
        if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array || results.GetArrayLength() == 0)
            return null;
        return PositiveIdOrNull(GetInt(results[0], "id"));
    }

    private static MediaResult? FirstMediaResult(JsonDocument? doc)
    {
        if (doc is null
            || !doc.RootElement.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        // Multi-search can also contain people. Walk a bounded prefix and select the first
        // actual work, preserving TMDB's relevance order without ever treating a person as media.
        foreach (var result in results.EnumerateArray().Take(20))
        {
            var id = PositiveIdOrNull(GetInt(result, "id"));
            var type = GetBoundedString(result, "media_type", 16);
            if (id is null)
                continue;
            if (string.Equals(type, "movie", StringComparison.Ordinal))
                return new MediaResult(MediaType.Movie, id.Value);
            if (string.Equals(type, "tv", StringComparison.Ordinal))
                return new MediaResult(MediaType.Tv, id.Value);
        }

        return null;
    }

    private static string? ExternalImdbId(JsonElement root)
    {
        if (root.TryGetProperty("external_ids", out var ext) && ext.ValueKind == JsonValueKind.Object)
            return NullIfEmpty(GetBoundedString(ext, "imdb_id", 32));
        return null;
    }

    private static int? FirstEpisodeRuntime(JsonElement root)
    {
        if (root.TryGetProperty("episode_run_time", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in arr.EnumerateArray().Take(100))
            {
                if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var minutes) &&
                    minutes is > 0 and <= 100_000)
                    return minutes;
            }
        }

        return null;
    }

    private string? Image(string? path, string size)
        => string.IsNullOrWhiteSpace(path) || !path.StartsWith("/", StringComparison.Ordinal)
            ? null
            : $"{options.ImageBaseUrl.TrimEnd('/')}/{size}{path}";

    private static int? YearOf(string? date)
        => date is { Length: >= 4 } && int.TryParse(date.AsSpan(0, 4), out var year) &&
           year is >= 1800 and <= 3000
            ? year
            : null;

    private static string? GetString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? GetBoundedString(JsonElement element, string name, int maxChars)
    {
        var value = GetString(element, name);
        return value is { Length: > 0 } && value.Length <= maxChars && !value.Any(char.IsControl)
            ? value
            : null;
    }

    private static int? GetInt(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var i)
            ? i
            : null;

    private static int? PositiveIdOrNull(int? value) => value is > 0 ? value : null;

    private static int? RuntimeOrNull(int? value) => value is > 0 and <= 100_000 ? value : null;

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    private readonly record struct MediaResult(MediaType Type, int Id);
}
