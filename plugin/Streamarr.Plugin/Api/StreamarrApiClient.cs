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
public sealed class StreamarrApiClient(HttpClient httpClient, ILogger<StreamarrApiClient> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>The Bearer used by ffmpeg to authenticate against <c>/stream</c>.</summary>
    public string ApiKey => Config.ApiKey;

    private static PluginConfiguration Config =>
        Plugin.Instance?.Configuration ?? new PluginConfiguration();

    private static string BaseUrl => Config.ServerUrl.TrimEnd('/');

    public async Task<HealthResponse?> GetHealthAsync(CancellationToken ct)
        => await SendAsync<HealthResponse>(HttpMethod.Get, "/api/v1/health?deep=false", null, ct).ConfigureAwait(false);

    public async Task<SearchResponse?> SearchAsync(string query, CancellationToken ct)
    {
        var profile = Config.ProfileId;
        var url = $"/api/v1/search?q={Uri.EscapeDataString(query)}";
        if (!string.IsNullOrWhiteSpace(profile))
            url += $"&profileId={Uri.EscapeDataString(profile)}";
        return await SendAsync<SearchResponse>(HttpMethod.Get, url, null, ct).ConfigureAwait(false);
    }

    public async Task<ResolveResponse?> ResolveAsync(string releaseId, CancellationToken ct)
        => await SendAsync<ResolveResponse>(
            HttpMethod.Post,
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = releaseId, Client = "jellyfin" },
            ct).ConfigureAwait(false);

    public async Task CloseSessionAsync(string token, CancellationToken ct)
        => await SendAsync<object>(HttpMethod.Post, $"/api/v1/sessions/{Uri.EscapeDataString(token)}/close", null, ct)
            .ConfigureAwait(false);

    public async Task ReportEventAsync(EventRequest ev, CancellationToken ct)
        => await SendAsync<object>(HttpMethod.Post, "/api/v1/events", ev, ct).ConfigureAwait(false);

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

    private async Task<T?> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct)
        where T : class
    {
        using var request = new HttpRequestMessage(method, BaseUrl + path);
        if (!string.IsNullOrWhiteSpace(Config.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Config.ApiKey);
        if (body is not null)
            request.Content = JsonContent.Create(body, options: JsonOptions);

        using var response = await httpClient.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await ReadErrorAsync(response, ct).ConfigureAwait(false);
            logger.LogWarning(
                "Streamarr API {Method} {Path} failed: {Status} {Detail}",
                method, path, (int)response.StatusCode, detail);
            throw new StreamarrApiException(response.StatusCode, detail);
        }

        if (typeof(T) == typeof(object))
            return null;

        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, ct).ConfigureAwait(false);
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var error = await response.Content.ReadFromJsonAsync<ErrorResponse>(JsonOptions, ct).ConfigureAwait(false);
            if (error?.Error is { } detail)
                return $"{detail.Code}: {detail.Message}";
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException or NotSupportedException)
        {
            // fall through to status text
        }

        return response.ReasonPhrase ?? response.StatusCode.ToString();
    }
}

/// <summary>Raised when the Core Server returns a non-success status.</summary>
public sealed class StreamarrApiException(System.Net.HttpStatusCode statusCode, string detail)
    : Exception($"Streamarr Core Server returned {(int)statusCode}: {detail}")
{
    public System.Net.HttpStatusCode StatusCode { get; } = statusCode;
}
