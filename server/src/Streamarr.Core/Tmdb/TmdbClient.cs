using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
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
public sealed class TmdbClient(
    HttpClient httpClient,
    TmdbOptions options,
    ILogger<TmdbClient>? logger = null,
    Func<TimeSpan, CancellationToken, Task>? retryDelay = null) : ITmdbClient
{
    private const int MaxDiscoveryCandidates = 20;
    private readonly ILogger _logger = logger ?? NullLogger<TmdbClient>.Instance;

    // Injectable so tests can retry without real wall-clock waits.
    private readonly Func<TimeSpan, CancellationToken, Task> _delay =
        retryDelay ?? ((delay, ct) => Task.Delay(delay, ct));

    private bool HasCredential => !string.IsNullOrWhiteSpace(options.ApiKey);

    public async Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(
        string query,
        MediaType? mediaType,
        CancellationToken cancellationToken)
    {
        if (!HasCredential || string.IsNullOrWhiteSpace(query))
            return [];

        var route = mediaType switch
        {
            MediaType.Movie => "search/movie",
            MediaType.Tv => "search/tv",
            _ => "search/multi",
        };
        using var doc = await GetAsync($"{route}?query={Uri.EscapeDataString(query)}", cancellationToken);
        return DiscoveryResults(doc, mediaType);
    }

    public async Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
    {
        if (!HasCredential || string.IsNullOrWhiteSpace(query))
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
        if (!HasCredential || string.IsNullOrWhiteSpace(title))
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
        if (!HasCredential || string.IsNullOrWhiteSpace(title))
            return null;

        using var doc = await GetAsync($"search/tv?query={Uri.EscapeDataString(title)}", cancellationToken);
        var id = FirstResultId(doc);
        return id is { } tmdbId ? await GetTvAsync(tmdbId, cancellationToken) : null;
    }

    public async Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
    {
        if (!HasCredential || tmdbId <= 0)
            return null;

        using var doc = await GetAsync(
            $"movie/{tmdbId}?append_to_response=credits,release_dates,videos",
            cancellationToken);
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
            OriginalTitle = NullIfEmpty(GetBoundedString(root, "original_title", 512)),
            Tagline = NullIfEmpty(GetBoundedString(root, "tagline", 2_048)),
            OfficialRating = MovieCertification(root),
            CommunityRating = RatingOrNull(GetFloat(root, "vote_average")),
            Genres = Names(root, "genres"),
            Studios = Names(root, "production_companies"),
            ProductionLocations = Names(root, "production_countries"),
            People = Credits(root),
            TrailerUrl = TrailerUrl(root),
        };
    }

    public async Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
        => (await GetTvSeriesCatalogAsync(tmdbId, cancellationToken))?.Series;

    public async Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(
        int tmdbId,
        CancellationToken cancellationToken)
    {
        if (!HasCredential || tmdbId <= 0)
            return null;

        using var doc = await GetAsync(
            $"tv/{tmdbId}?append_to_response=external_ids,credits,content_ratings,videos",
            cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        var series = new TmdbMatch
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
            OriginalTitle = NullIfEmpty(GetBoundedString(root, "original_name", 512)),
            Tagline = NullIfEmpty(GetBoundedString(root, "tagline", 2_048)),
            OfficialRating = TvCertification(root),
            CommunityRating = RatingOrNull(GetFloat(root, "vote_average")),
            Genres = Names(root, "genres"),
            Studios = Names(root, "networks")
                .Concat(Names(root, "production_companies"))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(64)
                .ToArray(),
            ProductionLocations = Names(root, "production_countries"),
            People = Credits(root),
            TrailerUrl = TrailerUrl(root),
        };

        return new TmdbTvSeriesCatalog
        {
            Series = series,
            Seasons = SeasonSummaries(root),
        };
    }

    public async Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(
        int tmdbId,
        int seasonNumber,
        CancellationToken cancellationToken)
    {
        if (!HasCredential || tmdbId <= 0 || seasonNumber < 0)
            return null;

        using var doc = await GetAsync($"tv/{tmdbId}/season/{seasonNumber}", cancellationToken);
        if (doc is null)
            return null;

        var root = doc.RootElement;
        var episodes = new List<TmdbEpisode>();
        if (root.TryGetProperty("episodes", out var array) && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var episode in array.EnumerateArray().Take(1_000))
            {
                if (GetInt(episode, "episode_number") is not int episodeNumber
                    || episodeNumber is < 1 or > 100_000)
                    continue;

                episodes.Add(new TmdbEpisode
                {
                    EpisodeNumber = episodeNumber,
                    Title = GetBoundedString(episode, "name", 512) ?? $"Episode {episodeNumber}",
                    Overview = NullIfEmpty(GetBoundedString(episode, "overview", 8_192)),
                    AirDate = SafeDate(GetBoundedString(episode, "air_date", 32)),
                    RuntimeMinutes = RuntimeOrNull(GetInt(episode, "runtime")),
                    StillUrl = Image(GetBoundedString(episode, "still_path", 1_024), options.BackdropSize),
                    CommunityRating = RatingOrNull(GetFloat(episode, "vote_average")),
                    People = EpisodeCredits(episode),
                });
            }
        }

        return new TmdbTvSeasonCatalog
        {
            TmdbId = tmdbId,
            SeasonNumber = seasonNumber,
            Title = GetBoundedString(root, "name", 512)
                    ?? (seasonNumber == 0 ? "Specials" : $"Season {seasonNumber}"),
            Overview = NullIfEmpty(GetBoundedString(root, "overview", 8_192)),
            AirDate = SafeDate(GetBoundedString(root, "air_date", 32)),
            PosterUrl = Image(GetBoundedString(root, "poster_path", 1_024), options.PosterSize),
            Episodes = episodes
                .GroupBy(episode => episode.EpisodeNumber)
                .Select(group => group.First())
                .OrderBy(episode => episode.EpisodeNumber)
                .ToArray(),
        };
    }

    public async Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken)
    {
        if (!HasCredential || string.IsNullOrWhiteSpace(imdbId))
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
        // Snapshot the mutable runtime credential once per request. Settings updates may
        // replace it while the process is running.
        var credential = TmdbOptions.NormalizeCredential(options.ApiKey);
        if (credential.Length == 0)
            return null;

        var bearer = TmdbOptions.IsBearerCredential(credential);
        var url = BuildUrl(relativeUrl, credential, bearer);
        var route = relativeUrl.Split('?', 2)[0];

        // A transient failure on a single metadata request is the difference between a work
        // showing its poster and showing nothing, so retry a bounded number of times with
        // jittered backoff before giving up. All attempts share the caller's deadline
        // (the caching decorator's per-lookup timeout), so this never runs unbounded.
        var maxAttempts = 1 + options.TransientRetryCount;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await AttemptGetAsync(url, route, credential, bearer, cancellationToken);
            }
            catch (TmdbTransientException transient) when (attempt < maxAttempts)
            {
                var wait = BackoffDelay(attempt, transient.RetryAfter);
                _logger.LogDebug(
                    "TMDB {Route} transient failure; retrying (attempt {Attempt}/{Max}) after {DelayMs} ms",
                    route,
                    attempt,
                    maxAttempts,
                    (int)wait.TotalMilliseconds);
                await _delay(wait, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<JsonDocument?> AttemptGetAsync(
        Uri url,
        string route,
        string credential,
        bool bearer,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (bearer)
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogDebug("TMDB {Route} returned HTTP {Status}", route, (int)response.StatusCode);
                if (IsTransient(response.StatusCode))
                    throw new TmdbTransientException(
                        $"TMDB {route} temporarily returned HTTP {(int)response.StatusCode}.",
                        RetryAfter(response));
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
            throw new TmdbTransientException($"TMDB {route} temporarily failed.");
        }
    }

    private static bool IsTransient(HttpStatusCode statusCode)
        => statusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
           || (int)statusCode >= 500;

    /// <summary>
    /// Backoff for retry <paramref name="attempt"/> (1-based). Honours a server-advertised
    /// <paramref name="retryAfter"/> when present, otherwise grows exponentially from the
    /// configured base with up to ±25% jitter, always capped by the configured maximum.
    /// </summary>
    private TimeSpan BackoffDelay(int attempt, TimeSpan? retryAfter)
    {
        var cap = options.RetryMaxDelay;
        if (retryAfter is { } advertised && advertised > TimeSpan.Zero)
            return advertised < cap ? advertised : cap;

        var baseMs = options.RetryBaseDelay.TotalMilliseconds;
        if (baseMs <= 0)
            return TimeSpan.Zero;

        var exponential = baseMs * Math.Pow(2, attempt - 1);
        var jitter = exponential * 0.25 * (Random.Shared.NextDouble() * 2 - 1);
        var total = Math.Clamp(exponential + jitter, 0, cap.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(total);
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response)
    {
        var header = response.Headers.RetryAfter;
        if (header is null)
            return null;
        if (header.Delta is { } delta && delta > TimeSpan.Zero)
            return delta;
        if (header.Date is { } date)
        {
            var wait = date - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero)
                return wait;
        }

        return null;
    }

    private Uri BuildUrl(string relativeUrl, string credential, bool bearer)
    {
        var baseUrl = options.BaseUrl.TrimEnd('/');
        var sb = new StringBuilder(baseUrl).Append('/').Append(relativeUrl);
        var separator = relativeUrl.Contains('?') ? '&' : '?';
        if (!bearer)
        {
            sb.Append(separator).Append("api_key=").Append(Uri.EscapeDataString(credential));
            separator = '&';
        }
        if (!string.IsNullOrWhiteSpace(options.Language))
            sb.Append(separator).Append("language=").Append(Uri.EscapeDataString(options.Language));
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

    private IReadOnlyList<TmdbMatch> DiscoveryResults(JsonDocument? doc, MediaType? forcedType)
    {
        if (doc is null
            || !doc.RootElement.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var matches = new List<TmdbMatch>(Math.Min(results.GetArrayLength(), MaxDiscoveryCandidates));
        var seen = new HashSet<(MediaType Type, int Id)>();
        foreach (var result in results.EnumerateArray().Take(MaxDiscoveryCandidates * 2))
        {
            var id = PositiveIdOrNull(GetInt(result, "id"));
            var type = forcedType ?? MediaTypeOf(result);
            if (id is null || type is null || !seen.Add((type.Value, id.Value)))
                continue;

            var title = type == MediaType.Movie
                ? GetBoundedString(result, "title", 512) ?? GetBoundedString(result, "original_title", 512)
                : GetBoundedString(result, "name", 512) ?? GetBoundedString(result, "original_name", 512);
            if (string.IsNullOrWhiteSpace(title))
                continue;

            var date = type == MediaType.Movie
                ? GetBoundedString(result, "release_date", 32)
                : GetBoundedString(result, "first_air_date", 32);
            matches.Add(new TmdbMatch
            {
                MediaType = type.Value,
                TmdbId = id.Value,
                Title = title,
                Year = YearOf(date),
                Overview = NullIfEmpty(GetBoundedString(result, "overview", 8_192)),
                PosterUrl = Image(GetBoundedString(result, "poster_path", 1_024), options.PosterSize),
                BackdropUrl = Image(GetBoundedString(result, "backdrop_path", 1_024), options.BackdropSize),
            });

            if (matches.Count >= MaxDiscoveryCandidates)
                break;
        }

        return matches;
    }

    private static MediaType? MediaTypeOf(JsonElement result)
        => GetBoundedString(result, "media_type", 16) switch
        {
            "movie" => MediaType.Movie,
            "tv" => MediaType.Tv,
            _ => null,
        };

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

    private IReadOnlyList<TmdbSeasonSummary> SeasonSummaries(JsonElement root)
    {
        if (!root.TryGetProperty("seasons", out var array) || array.ValueKind != JsonValueKind.Array)
            return [];

        var seasons = new List<TmdbSeasonSummary>();
        foreach (var season in array.EnumerateArray().Take(250))
        {
            if (GetInt(season, "season_number") is not int seasonNumber
                || GetInt(season, "episode_count") is not int episodeCount
                || seasonNumber is < 0 or > 100_000
                || episodeCount is < 0 or > 100_000)
                continue;

            seasons.Add(new TmdbSeasonSummary
            {
                SeasonNumber = seasonNumber,
                Title = GetBoundedString(season, "name", 512)
                        ?? (seasonNumber == 0 ? "Specials" : $"Season {seasonNumber}"),
                Overview = NullIfEmpty(GetBoundedString(season, "overview", 8_192)),
                AirDate = SafeDate(GetBoundedString(season, "air_date", 32)),
                PosterUrl = Image(GetBoundedString(season, "poster_path", 1_024), options.PosterSize),
                EpisodeCount = episodeCount,
            });
        }

        return seasons
            .GroupBy(season => season.SeasonNumber)
            .Select(group => group.First())
            .OrderBy(season => season.SeasonNumber)
            .ToArray();
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

    private static string? SafeDate(string? date)
        => date is { Length: 10 }
           && DateOnly.TryParseExact(
               date,
               "yyyy-MM-dd",
               CultureInfo.InvariantCulture,
               DateTimeStyles.None,
               out _)
            ? date
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

    private static float? GetFloat(JsonElement element, string name)
        => element.TryGetProperty(name, out var value)
           && value.ValueKind == JsonValueKind.Number
           && value.TryGetSingle(out var number)
            ? number
            : null;

    private static int? PositiveIdOrNull(int? value) => value is > 0 ? value : null;

    private static int? RuntimeOrNull(int? value) => value is > 0 and <= 100_000 ? value : null;

    private static float? RatingOrNull(float? value)
        => value is >= 0 and <= 10 ? value : null;

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    private static IReadOnlyList<string> Names(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array)
            return [];

        return array.EnumerateArray()
            .Take(64)
            .Select(value => GetBoundedString(value, "name", 256))
            .Where(value => value is not null)
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private IReadOnlyList<TmdbPerson> Credits(JsonElement root)
    {
        if (!root.TryGetProperty("credits", out var credits) || credits.ValueKind != JsonValueKind.Object)
            return [];

        var people = new List<TmdbPerson>();
        AddCast(people, credits);
        AddCrew(people, credits);
        return people.Take(100).ToArray();
    }

    private IReadOnlyList<TmdbPerson> EpisodeCredits(JsonElement episode)
    {
        var people = new List<TmdbPerson>();
        AddPeopleArray(people, episode, "guest_stars", "Actor", roleProperty: "character", take: 40);
        AddPeopleArray(people, episode, "crew", type: null, roleProperty: "job", take: 40);
        return people.Take(80).ToArray();
    }

    private void AddCast(List<TmdbPerson> people, JsonElement credits)
        => AddPeopleArray(people, credits, "cast", "Actor", roleProperty: "character", take: 60);

    private void AddCrew(List<TmdbPerson> people, JsonElement credits)
        => AddPeopleArray(people, credits, "crew", type: null, roleProperty: "job", take: 60);

    private void AddPeopleArray(
        List<TmdbPerson> people,
        JsonElement parent,
        string property,
        string? type,
        string roleProperty,
        int take)
    {
        if (!parent.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array)
            return;

        foreach (var value in array.EnumerateArray().Take(take))
        {
            var name = GetBoundedString(value, "name", 256);
            var role = NullIfEmpty(GetBoundedString(value, roleProperty, 256));
            var resolvedType = type ?? CrewType(role);
            if (name is null || resolvedType is null)
                continue;

            people.Add(new TmdbPerson
            {
                Name = name,
                Type = resolvedType,
                Role = role,
                SortOrder = GetInt(value, "order") is >= 0 and <= 10_000 ? GetInt(value, "order") : null,
                TmdbId = PositiveIdOrNull(GetInt(value, "id")),
                ProfileUrl = Image(GetBoundedString(value, "profile_path", 1_024), "w500"),
            });
        }
    }

    private static string? CrewType(string? job) => job switch
    {
        "Director" => "Director",
        "Writer" or "Screenplay" or "Story" or "Teleplay" => "Writer",
        "Producer" or "Executive Producer" => "Producer",
        "Composer" or "Original Music Composer" => "Composer",
        _ => null,
    };

    private static string? MovieCertification(JsonElement root)
    {
        if (!root.TryGetProperty("release_dates", out var releaseDates)
            || !releaseDates.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        return Certification(results.EnumerateArray(), "release_dates", "certification");
    }

    private static string? TvCertification(JsonElement root)
    {
        if (!root.TryGetProperty("content_ratings", out var ratings)
            || !ratings.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var country in PreferredCountries(results.EnumerateArray()))
        {
            var rating = NullIfEmpty(GetBoundedString(country, "rating", 32));
            if (rating is not null)
                return rating;
        }

        return null;
    }

    private static string? Certification(
        JsonElement.ArrayEnumerator countries,
        string nestedProperty,
        string valueProperty)
    {
        foreach (var country in PreferredCountries(countries))
        {
            if (!country.TryGetProperty(nestedProperty, out var values) || values.ValueKind != JsonValueKind.Array)
                continue;
            foreach (var value in values.EnumerateArray().Take(20))
            {
                var certification = NullIfEmpty(GetBoundedString(value, valueProperty, 32));
                if (certification is not null)
                    return certification;
            }
        }

        return null;
    }

    private static IEnumerable<JsonElement> PreferredCountries(JsonElement.ArrayEnumerator countries)
    {
        var bounded = countries.Take(64).ToArray();
        return bounded
            .OrderBy(country => string.Equals(GetBoundedString(country, "iso_3166_1", 8), "US", StringComparison.Ordinal) ? 0 : 1);
    }

    private static string? TrailerUrl(JsonElement root)
    {
        if (!root.TryGetProperty("videos", out var videos)
            || !videos.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var candidates = results.EnumerateArray()
            .Take(100)
            .Where(video => string.Equals(GetBoundedString(video, "site", 32), "YouTube", StringComparison.Ordinal))
            .Where(video => string.Equals(GetBoundedString(video, "type", 32), "Trailer", StringComparison.Ordinal))
            .OrderByDescending(video => video.TryGetProperty("official", out var official) && official.ValueKind == JsonValueKind.True);
        foreach (var video in candidates)
        {
            var key = GetBoundedString(video, "key", 128);
            if (key is not null && key.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
                return $"https://www.youtube.com/watch?v={key}";
        }

        return null;
    }

    private readonly record struct MediaResult(MediaType Type, int Id);
}
