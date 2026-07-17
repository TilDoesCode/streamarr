using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin.Api;

/// <summary>
/// Typed HTTP client over the Streamarr Core Server API (BRIEF §8.1). Registered as a
/// named <see cref="HttpClient"/> by <see cref="PluginServiceRegistrator"/>. Every call
/// reads the current <see cref="PluginConfiguration"/> so server URL / API key changes
/// take effect without a restart. This class is transport only — it never interprets
/// results (no ranking, no fallback selection; those are the server's job).
/// </summary>
public sealed class StreamarrApiClient
{
    internal const int MaxApiResponseBytes = 4 * 1024 * 1024;
    private const int MaxErrorResponseBytes = 16 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
    };

    private readonly HttpClient _httpClient;
    private readonly ILogger<StreamarrApiClient> _logger;
    private readonly Func<PluginConfiguration> _configuration;

    public StreamarrApiClient(HttpClient httpClient, ILogger<StreamarrApiClient> logger)
        : this(httpClient, logger, static () => Plugin.Instance?.Configuration ?? new PluginConfiguration())
    {
    }

    internal StreamarrApiClient(
        HttpClient httpClient,
        ILogger<StreamarrApiClient> logger,
        Func<PluginConfiguration> configuration)
    {
        _httpClient = httpClient;
        _logger = logger;
        _configuration = configuration;
    }

    private PluginConfiguration Config => _configuration();

    private string BaseUrl => Config.ServerUrl.TrimEnd('/');

    private string PublicStreamUrl => string.IsNullOrWhiteSpace(Config.PublicStreamUrl)
        ? BaseUrl
        : Config.PublicStreamUrl.TrimEnd('/');

    public async Task<HealthResponse?> GetHealthAsync(CancellationToken ct)
    {
        var response = await SendAsync<HealthResponse>(HttpMethod.Get, "/api/v1/health?deep=false", null, ct)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<CapsResponse?> GetCapsAsync(CancellationToken ct)
    {
        var response = await SendAsync<CapsResponse>(HttpMethod.Get, "/api/v1/caps", null, ct)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    /// <summary>
    /// Verifies both reachability and machine-key authorization. Health is intentionally public
    /// on Core, so a successful health response alone must never be reported as a valid setup.
    /// </summary>
    public async Task<HealthResponse> TestConnectionAsync(CancellationToken ct)
    {
        var health = await GetHealthAsync(ct).ConfigureAwait(false)
                     ?? throw new InvalidOperationException("Core returned an empty health response.");
        _ = await GetCapsAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Core returned an empty capabilities response.");
        return health;
    }

    public async Task<SearchResponse?> SearchAsync(string query, CancellationToken ct)
        => await SearchAsync(query, mediaType: null, ct).ConfigureAwait(false);

    public async Task<SearchResponse?> SearchAsync(string query, string? mediaType, CancellationToken ct)
    {
        var profile = Config.ProfileId;
        var url = $"/api/v1/search?q={Uri.EscapeDataString(query)}";
        if (mediaType is "movie" or "tv")
            url += $"&type={mediaType}";
        if (!string.IsNullOrWhiteSpace(profile))
            url += $"&profileId={Uri.EscapeDataString(profile)}";
        var response = await SendAsync<SearchResponse>(HttpMethod.Get, url, null, ct).ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<TvSeriesSearchResponse?> SearchTvSeriesAsync(string query, CancellationToken ct)
    {
        var response = await SendAsync<TvSeriesSearchResponse>(
                HttpMethod.Get,
                $"/api/v1/tv/search?q={Uri.EscapeDataString(query)}&limit=3",
                null,
                ct)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<TvSeriesDetailsResponse?> GetTvSeriesAsync(int tmdbId, CancellationToken ct)
        => StreamarrPayloadBounds.Normalize(await SendAsync<TvSeriesDetailsResponse>(
                HttpMethod.Get,
                $"/api/v1/tv/{tmdbId}",
                null,
                ct)
            .ConfigureAwait(false));

    public async Task<TvSeasonDetailsResponse?> GetTvSeasonAsync(
        int tmdbId,
        int seasonNumber,
        CancellationToken ct)
    {
        var profile = Config.ProfileId;
        var path = $"/api/v1/tv/{tmdbId}/seasons/{seasonNumber}";
        if (!string.IsNullOrWhiteSpace(profile))
            path += $"?profileId={Uri.EscapeDataString(profile)}";
        return StreamarrPayloadBounds.Normalize(await SendAsync<TvSeasonDetailsResponse>(
                HttpMethod.Get,
                path,
                null,
                ct)
            .ConfigureAwait(false));
    }

    public async Task<ResolveResponse?> ResolveAsync(string releaseId, CancellationToken ct)
        => await ResolveAsync(releaseId, workId: null, ct).ConfigureAwait(false);

    public async Task<ResolveResponse?> ResolveAsync(string releaseId, string? workId, CancellationToken ct)
        => StreamarrPayloadBounds.Normalize(await SendAsync<ResolveResponse>(
            HttpMethod.Post,
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = releaseId, WorkId = workId, Client = "jellyfin" },
            ct).ConfigureAwait(false));

    public async Task CloseSessionAsync(string token, CancellationToken ct)
        => await SendAsync<object>(
                HttpMethod.Post,
                $"/api/v1/sessions/{Uri.EscapeDataString(token)}/close",
                null,
                ct,
                notFoundIsSuccess: true)
            .ConfigureAwait(false);

    public async Task ReportEventAsync(EventRequest ev, CancellationToken ct)
        => await SendAsync<object>(HttpMethod.Post, "/api/v1/events", ev, ct).ConfigureAwait(false);

    /// <summary>
    /// Resolves Core's session-capability path against the client-reachable stream base URL.
    /// Core API traffic may use a private origin while the returned media path uses an HTTPS/LAN
    /// origin reachable by Streamyfin and other direct remote-source clients. Absolute URLs from
    /// Core are accepted only for backward compatibility and must remain on a configured origin.
    /// </summary>
    public string ResolveStreamUrl(string? streamUrl)
        => ResolveStreamUrl(BaseUrl, PublicStreamUrl, streamUrl);

    internal static string ResolveStreamUrl(string configuredBaseUrl, string? streamUrl)
        => ResolveStreamUrl(configuredBaseUrl, configuredBaseUrl, streamUrl);

    internal static string ResolveStreamUrl(
        string configuredBaseUrl,
        string configuredPublicStreamUrl,
        string? streamUrl)
    {
        if (!Uri.TryCreate(configuredBaseUrl, UriKind.Absolute, out var baseUri)
            || !IsHttpScheme(baseUri.Scheme)
            || !string.IsNullOrEmpty(baseUri.UserInfo))
        {
            throw new InvalidOperationException("The configured Streamarr Core Server URL is invalid.");
        }

        if (!Uri.TryCreate(configuredPublicStreamUrl, UriKind.Absolute, out var publicUri)
            || !IsHttpScheme(publicUri.Scheme)
            || !string.IsNullOrEmpty(publicUri.UserInfo)
            || !string.IsNullOrEmpty(publicUri.Query)
            || !string.IsNullOrEmpty(publicUri.Fragment))
        {
            throw new InvalidOperationException("The configured public Streamarr stream URL is invalid.");
        }

        if (string.IsNullOrWhiteSpace(streamUrl)
            || !Uri.TryCreate(baseUri, streamUrl, out var returnedUri)
            || !IsHttpScheme(returnedUri.Scheme)
            || !string.IsNullOrEmpty(returnedUri.UserInfo)
            || !string.IsNullOrEmpty(returnedUri.Fragment)
            || !string.IsNullOrEmpty(returnedUri.Query)
            || !IsConfiguredOrigin(returnedUri, baseUri, publicUri)
            || !IsCapabilityPath(returnedUri.AbsolutePath))
        {
            throw new InvalidOperationException("Core returned an invalid or cross-origin stream capability URL.");
        }

        var publicBase = configuredPublicStreamUrl.TrimEnd('/');
        if (!Uri.TryCreate(publicBase + returnedUri.AbsolutePath, UriKind.Absolute, out var resolved)
            || !SameOrigin(resolved, publicUri))
        {
            throw new InvalidOperationException("The public Streamarr capability URL could not be constructed.");
        }

        return resolved.AbsoluteUri;
    }

    private static bool IsConfiguredOrigin(Uri candidate, Uri baseUri, Uri publicUri)
        => SameOrigin(candidate, baseUri) || SameOrigin(candidate, publicUri);

    private static bool SameOrigin(Uri left, Uri right)
        => string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase)
           && string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase)
           && left.Port == right.Port;

    private static bool IsHttpScheme(string scheme)
        => string.Equals(scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
           || string.Equals(scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);

    private static bool IsCapabilityPath(string path)
    {
        const string prefix = "/api/v1/stream/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal))
            return false;
        var token = path.AsSpan(prefix.Length);
        return token.Length is > 0 and <= 256
               && token.IndexOfAnyExcept("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".AsSpan()) < 0;
    }

    /// <summary>Extracts the opaque stream token from a Core Server stream URL.</summary>
    public static string? TokenFromStreamUrl(string? streamUrl)
    {
        if (string.IsNullOrWhiteSpace(streamUrl))
            return null;
        var trimmed = streamUrl.Split('?')[0].TrimEnd('/');
        var idx = trimmed.LastIndexOf("/stream/", StringComparison.OrdinalIgnoreCase);
        if (idx < 0)
            return null;
        var token = trimmed[(idx + "/stream/".Length)..];
        return string.IsNullOrWhiteSpace(token) ? null : token;
    }

    private async Task<T?> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        CancellationToken ct,
        bool notFoundIsSuccess = false)
        where T : class
    {
        using var request = new HttpRequestMessage(method, BaseUrl + path);
        if (!string.IsNullOrWhiteSpace(Config.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Config.ApiKey);
        if (body is not null)
            request.Content = JsonContent.Create(body, options: JsonOptions);

        // Stream response bodies so the endpoint-specific readers enforce their byte
        // ceilings before HttpClient can buffer an entire untrusted Core response.
        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode
            && !(notFoundIsSuccess && response.StatusCode == System.Net.HttpStatusCode.NotFound))
        {
            // Session URLs contain bearer capabilities. Never accept or log a server-provided
            // error body for those requests because a peer could reflect the token in it.
            var capabilityRequest = path.StartsWith("/api/v1/sessions/", StringComparison.OrdinalIgnoreCase);
            var detail = capabilityRequest
                ? "session_close_failed"
                : await ReadErrorAsync(response, ct).ConfigureAwait(false);
            _logger.LogWarning(
                "Streamarr API {Method} {Path} failed: {Status} {Detail}",
                method, SafeLogPath(path), (int)response.StatusCode, detail);
            throw new StreamarrApiException(response.StatusCode, detail);
        }

        if (typeof(T) == typeof(object))
            return null;

        var payload = await ReadBoundedAsync(response.Content, MaxApiResponseBytes, ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<T>(payload, JsonOptions);
    }

    internal static string SafeLogPath(string path)
    {
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        var pathOnly = queryIndex < 0 ? path : path[..queryIndex];
        return pathOnly.StartsWith("/api/v1/sessions/", StringComparison.OrdinalIgnoreCase)
            ? "/api/v1/sessions/{session}/close"
            : pathOnly;
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var payload = await ReadBoundedAsync(response.Content, MaxErrorResponseBytes, ct).ConfigureAwait(false);
            var error = JsonSerializer.Deserialize<ErrorResponse>(payload, JsonOptions);
            if (error?.Error is { } detail)
                return $"{BoundError(detail.Code)}: {BoundError(detail.Message)}";
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException or NotSupportedException or InvalidDataException)
        {
            // fall through to status text
        }

        return response.ReasonPhrase ?? response.StatusCode.ToString();
    }

    private static string BoundError(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return "unknown";
        var bounded = value.AsSpan(0, Math.Min(value.Length, 512));
        var result = new char[bounded.Length];
        for (var index = 0; index < bounded.Length; index++)
            result[index] = char.IsControl(bounded[index]) ? ' ' : bounded[index];
        return new string(result);
    }

    private static async Task<byte[]> ReadBoundedAsync(HttpContent content, int maximumBytes, CancellationToken ct)
    {
        if (content.Headers.ContentLength is > 0 and var declaredLength && declaredLength > maximumBytes)
            throw new InvalidDataException($"Core response exceeded the {maximumBytes}-byte limit.");

        await using var source = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var destination = new MemoryStream(
            content.Headers.ContentLength is > 0 and <= int.MaxValue
                ? Math.Min((int)content.Headers.ContentLength.Value, maximumBytes)
                : 0);
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(buffer, ct).ConfigureAwait(false);
            if (read == 0)
                break;
            if (destination.Length + read > maximumBytes)
                throw new InvalidDataException($"Core response exceeded the {maximumBytes}-byte limit.");
            destination.Write(buffer, 0, read);
        }

        return destination.ToArray();
    }
}

/// <summary>Raised when the Core Server returns a non-success status.</summary>
public sealed class StreamarrApiException(System.Net.HttpStatusCode statusCode, string detail)
    : Exception($"Streamarr Core Server returned {(int)statusCode}: {detail}")
{
    public System.Net.HttpStatusCode StatusCode { get; } = statusCode;
}
