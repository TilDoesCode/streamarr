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

    public async Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
    {
        if (!HasKey || string.IsNullOrWhiteSpace(title))
            return null;

        var query = new StringBuilder("search/movie?query=").Append(Uri.EscapeDataString(title));
        if (year is { } y)
            query.Append("&year=").Append(y.ToString(CultureInfo.InvariantCulture));

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
        if (!HasKey)
            return null;

        using var doc = await GetAsync($"movie/{tmdbId}", cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        return new TmdbMatch
        {
            MediaType = MediaType.Movie,
            TmdbId = tmdbId,
            ImdbId = NullIfEmpty(GetString(root, "imdb_id")),
            Title = GetString(root, "title") ?? GetString(root, "original_title") ?? $"Movie {tmdbId}",
            Year = YearOf(GetString(root, "release_date")),
            Overview = NullIfEmpty(GetString(root, "overview")),
            PosterUrl = Image(GetString(root, "poster_path"), options.PosterSize),
            BackdropUrl = Image(GetString(root, "backdrop_path"), options.BackdropSize),
            RuntimeMinutes = PositiveOrNull(GetInt(root, "runtime")),
        };
    }

    public async Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (!HasKey)
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
            Title = GetString(root, "name") ?? GetString(root, "original_name") ?? $"Series {tmdbId}",
            Year = YearOf(GetString(root, "first_air_date")),
            Overview = NullIfEmpty(GetString(root, "overview")),
            PosterUrl = Image(GetString(root, "poster_path"), options.PosterSize),
            BackdropUrl = Image(GetString(root, "backdrop_path"), options.BackdropSize),
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
            var tmdbId = GetInt(movies[0], "id");
            return tmdbId is { } m ? await GetMovieAsync(m, cancellationToken) : null;
        }

        if (root.TryGetProperty("tv_results", out var shows) && shows.ValueKind == JsonValueKind.Array && shows.GetArrayLength() > 0)
        {
            var tmdbId = GetInt(shows[0], "id");
            return tmdbId is { } t ? await GetTvAsync(t, cancellationToken) : null;
        }

        return null;
    }

    private async Task<JsonDocument?> GetAsync(string relativeUrl, CancellationToken cancellationToken)
    {
        var url = BuildUrl(relativeUrl);
        try
        {
            using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("TMDB {Url} returned HTTP {Status}", relativeUrl, (int)response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or IOException or OperationCanceledException)
        {
            _logger.LogWarning(e, "TMDB request {Url} failed: {Message}", relativeUrl, e.Message);
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
        return GetInt(results[0], "id");
    }

    private static string? ExternalImdbId(JsonElement root)
    {
        if (root.TryGetProperty("external_ids", out var ext) && ext.ValueKind == JsonValueKind.Object)
            return NullIfEmpty(GetString(ext, "imdb_id"));
        return null;
    }

    private static int? FirstEpisodeRuntime(JsonElement root)
    {
        if (root.TryGetProperty("episode_run_time", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in arr.EnumerateArray())
            {
                if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var minutes) && minutes > 0)
                    return minutes;
            }
        }

        return null;
    }

    private string? Image(string? path, string size)
        => string.IsNullOrWhiteSpace(path)
            ? null
            : $"{options.ImageBaseUrl.TrimEnd('/')}/{size}{path}";

    private static int? YearOf(string? date)
        => date is { Length: >= 4 } && int.TryParse(date.AsSpan(0, 4), out var year) ? year : null;

    private static string? GetString(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? GetInt(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var i)
            ? i
            : null;

    private static int? PositiveOrNull(int? value) => value is > 0 ? value : null;

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
