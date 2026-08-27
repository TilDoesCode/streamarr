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
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;

    private readonly record struct TransportSnapshot(string BaseUrl, string ApiKey);

    public StreamarrApiClient(HttpClient httpClient, ILogger<StreamarrApiClient> logger)
        : this(httpClient, logger, static () => Plugin.Instance?.Configuration ?? new PluginConfiguration())
    {
    }

    internal StreamarrApiClient(
        HttpClient httpClient,
        ILogger<StreamarrApiClient> logger,
        Func<PluginConfiguration> configuration,
        Func<TimeSpan, CancellationToken, Task>? retryDelay = null)
    {
        _httpClient = httpClient;
        _logger = logger;
        _configuration = configuration;
        _delay = retryDelay ?? ((delay, ct) => Task.Delay(delay, ct));
    }

    private PluginConfiguration Config => _configuration();

    private string BaseUrl => Config.ServerUrl.TrimEnd('/');

    private string PublicStreamUrl => string.IsNullOrWhiteSpace(Config.PublicStreamUrl)
        ? BaseUrl
        : Config.PublicStreamUrl.TrimEnd('/');

    private TransportSnapshot CaptureTransport()
    {
        var config = Config;
        return new TransportSnapshot(config.ServerUrl.TrimEnd('/'), config.ApiKey);
    }

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
        var response = await SendAsync<SearchResponse>(HttpMethod.Get, url, null, ct, retryTransient: true).ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    /// <summary>
    /// Replays discovery for a previously materialized work after Core has restarted and
    /// lost its in-memory release registry. Stable TMDB/episode coordinates are preferred
    /// over title text so a persisted Jellyfin source cannot refresh the wrong work.
    /// </summary>
    public async Task<SearchResponse?> RefreshWorkAsync(WorkDto work, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(work);

        var parameters = new List<string>();
        if (work.TmdbId is > 0)
            parameters.Add($"tmdbId={work.TmdbId.Value}");
        else if (!string.IsNullOrWhiteSpace(work.Title))
            parameters.Add($"q={Uri.EscapeDataString(work.Title)}");
        else
            throw new InvalidOperationException("A persisted Streamarr work has no stable discovery identifier.");

        var isTv = work.MediaType is "tv" or "episode";
        var mediaType = isTv
            ? "tv"
            : work.MediaType == "movie"
                ? "movie"
                : null;
        if (mediaType is not null)
            parameters.Add($"type={mediaType}");
        if (isTv && work.Season is >= 0)
            parameters.Add($"season={work.Season.Value}");
        if (isTv && work.Episode is > 0)
            parameters.Add($"episode={work.Episode.Value}");
        if (!string.IsNullOrWhiteSpace(Config.ProfileId))
            parameters.Add($"profileId={Uri.EscapeDataString(Config.ProfileId)}");

        var response = await SendAsync<SearchResponse>(
                HttpMethod.Get,
                "/api/v1/search?" + string.Join('&', parameters),
                null,
                ct,
                retryTransient: true)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<TvSeriesSearchResponse?> SearchTvSeriesAsync(string query, CancellationToken ct)
    {
        var response = await SendAsync<TvSeriesSearchResponse>(
                HttpMethod.Get,
                $"/api/v1/tv/search?q={Uri.EscapeDataString(query)}&limit=3",
                null,
                ct,
                retryTransient: true)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<TvSeriesDetailsResponse?> GetTvSeriesAsync(int tmdbId, CancellationToken ct)
        => StreamarrPayloadBounds.Normalize(await SendAsync<TvSeriesDetailsResponse>(
                HttpMethod.Get,
                $"/api/v1/tv/{tmdbId}",
                null,
                ct,
                retryTransient: true)
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
                ct,
                retryTransient: true)
            .ConfigureAwait(false));
    }

    public async Task<LocalReleaseAvailabilityResponse?> GetLocalReleaseAvailabilityAsync(
        IReadOnlyList<string> workIds,
        string client,
        string requestedById,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(workIds);
        if (workIds.Count is < 1 or > StreamarrPayloadBounds.MaxLocalAvailabilityWorkIds)
            throw new ArgumentOutOfRangeException(nameof(workIds));
        ArgumentException.ThrowIfNullOrWhiteSpace(client);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestedById);

        var response = await SendAsync<LocalReleaseAvailabilityResponse>(
                HttpMethod.Post,
                "/api/v1/releases/local-availability",
                new LocalReleaseAvailabilityRequest
                {
                    WorkIds = workIds,
                    Client = client,
                    RequestedById = requestedById,
                },
                ct,
                notFoundIsSuccess: true,
                methodNotAllowedIsSuccess: true)
            .ConfigureAwait(false);
        return response is null ? null : StreamarrPayloadBounds.Normalize(response);
    }

    public async Task<ResolveResponse?> ResolveAsync(string releaseId, CancellationToken ct)
        => await ResolveAsync(releaseId, workId: null, ct).ConfigureAwait(false);

    public async Task<ResolveResponse?> ResolveAsync(string releaseId, string? workId, CancellationToken ct)
        => await ResolveAsync(releaseId, workId, requestedById: null, requestedByName: null, ct).ConfigureAwait(false);

    public async Task<ResolveResponse?> ResolveAsync(
        string releaseId,
        string? workId,
        string? requestedById,
        string? requestedByName,
        CancellationToken ct)
        => await ResolveAsync(
            releaseId,
            workId,
            requestedById,
            requestedByName,
            CaptureTransport(),
            ct).ConfigureAwait(false);

    private async Task<ResolveResponse?> ResolveAsync(
        string releaseId,
        string? workId,
        string? requestedById,
        string? requestedByName,
        TransportSnapshot transport,
        CancellationToken ct)
        => StreamarrPayloadBounds.Normalize(await SendAsync<ResolveResponse>(
            HttpMethod.Post,
            "/api/v1/resolve",
            new ResolveRequest
            {
                ReleaseId = releaseId,
                WorkId = workId,
                Client = "jellyfin",
                RequestedById = requestedById,
                RequestedByName = requestedByName,
            },
            ct,
            transport: transport).ConfigureAwait(false));

    /// <summary>
    /// Two-phase playback admission: the POST answers within Core's short hard budget; while
    /// the prepare (health check, materialization, ffprobe, repair analysis) continues
    /// server-side, this method polls the admission id in separate requests. That decouples
    /// Core's work from any individual HTTP request lifetime; Jellyfin still waits here while
    /// holding its global live-stream lock, bounded by the caller's deadline token. Falls back
    /// to the legacy single-phase resolve on older Cores without the endpoint.
    /// </summary>
    public async Task<ResolveResponse?> AdmitPlaybackAsync(
        string releaseId,
        string? workId,
        string? requestedById,
        string? requestedByName,
        CancellationToken ct)
    {
        var transport = CaptureTransport();
        string? admissionId = null;
        var lifecycleComplete = false;
        try
        {
            var initial = await SendAsync<PlaybackAdmissionDto>(
                    HttpMethod.Post,
                    "/api/v1/playback-sessions",
                    new ResolveRequest
                    {
                        ReleaseId = releaseId,
                        WorkId = workId,
                        Client = "jellyfin",
                        RequestedById = requestedById,
                        RequestedByName = requestedByName,
                    },
                    ct,
                    notFoundIsSuccess: true,
                    methodNotAllowedIsSuccess: true,
                    transport: transport)
                .ConfigureAwait(false);
            if (initial is null)
            {
                return await ResolveAsync(releaseId, workId, requestedById, requestedByName, transport, ct)
                    .ConfigureAwait(false);
            }

            // Preserve a valid id before validating the rest of the envelope, so even a
            // malformed Core response can be abandoned instead of consuming admission capacity.
            admissionId = StreamarrPayloadBounds.NormalizeAdmissionId(initial.AdmissionId);
            var admission = StreamarrPayloadBounds.Normalize(initial)
                            ?? throw new StreamarrApiException(
                                System.Net.HttpStatusCode.BadGateway,
                                "invalid_playback_admission_response");

            admissionId = admission.AdmissionId;
            var polls = 0;
            while (admission.Phase == "preparing")
            {
                if (++polls > 600)
                {
                    throw new StreamarrApiException(
                        System.Net.HttpStatusCode.GatewayTimeout,
                        "playback_admission_poll_limit");
                }

                await _delay(
                        TimeSpan.FromSeconds(admission.RetryAfterSeconds ?? 2),
                        ct)
                    .ConfigureAwait(false);
                var next = StreamarrPayloadBounds.Normalize(await SendAsync<PlaybackAdmissionDto>(
                        HttpMethod.Get,
                        $"/api/v1/playback-sessions/{Uri.EscapeDataString(admissionId)}",
                        null,
                        ct,
                        retryTransient: true,
                        transport: transport)
                    .ConfigureAwait(false));
                if (next is null || !string.Equals(next.AdmissionId, admissionId, StringComparison.Ordinal))
                {
                    throw new StreamarrApiException(
                        System.Net.HttpStatusCode.BadGateway,
                        "invalid_playback_admission_response");
                }

                admission = next;
            }

            if (admission.Phase == "ready")
            {
                var resolve = admission.Resolve
                              ?? throw new StreamarrApiException(
                                  System.Net.HttpStatusCode.BadGateway,
                                  "ready_playback_admission_missing_resolve");
                if (!HasCloseableStreamCapability(resolve))
                {
                    throw new StreamarrApiException(
                        System.Net.HttpStatusCode.BadGateway,
                        "invalid_ready_playback_admission_resolve");
                }

                // Claim is deliberately last: once Core removes the terminal admission, this
                // client owns the resulting stream capability. A Core without the handshake
                // cannot transfer ownership safely, so fail closed and abandon the admission.
                var claimResponse = await SendAsync<PlaybackAdmissionDto>(
                        HttpMethod.Post,
                        $"/api/v1/playback-sessions/{Uri.EscapeDataString(admissionId)}/claim",
                        null,
                        ct,
                        notFoundIsSuccess: true,
                        methodNotAllowedIsSuccess: true,
                        transport: transport)
                    .ConfigureAwait(false);
                if (claimResponse is null)
                {
                    throw new StreamarrApiException(
                        System.Net.HttpStatusCode.BadGateway,
                        "playback_admission_claim_unsupported");
                }

                var claimed = StreamarrPayloadBounds.Normalize(claimResponse)
                              ?? throw new StreamarrApiException(
                                  System.Net.HttpStatusCode.BadGateway,
                                  "invalid_playback_admission_claim");
                if (!string.Equals(claimed.AdmissionId, admissionId, StringComparison.Ordinal)
                    || claimed.Phase != "ready"
                    || claimed.Resolve is null
                    || !HasCloseableStreamCapability(claimed.Resolve))
                {
                    throw new StreamarrApiException(
                        System.Net.HttpStatusCode.BadGateway,
                        "invalid_playback_admission_claim");
                }

                resolve = claimed.Resolve;
                lifecycleComplete = true;
                return resolve;
            }

            // Core represents a fully evaluated dead release as phase=failed plus the same dead
            // resolve envelope used by the legacy API. Return it so the provider can follow
            // Core's suggested fallback; the finally block still abandons this failed admission.
            if (admission.Resolve is { } failedResolve)
            {
                if (string.Equals(failedResolve.Status, "dead", StringComparison.OrdinalIgnoreCase)
                    && string.IsNullOrWhiteSpace(failedResolve.StreamUrl))
                {
                    return failedResolve;
                }

                throw new StreamarrApiException(
                    System.Net.HttpStatusCode.BadGateway,
                    "invalid_failed_playback_admission_resolve");
            }

            if (string.Equals(admission.Error, "unknown_release", StringComparison.Ordinal))
                throw new StreamarrApiException(System.Net.HttpStatusCode.NotFound, "unknown_release");
            throw new StreamarrApiException(
                System.Net.HttpStatusCode.BadGateway,
                $"playback_admission_failed:{admission.Error ?? "unknown"}");
        }
        finally
        {
            if (admissionId is not null && !lifecycleComplete)
                await AbandonPlaybackAdmissionAsync(admissionId, transport).ConfigureAwait(false);
        }
    }

    private async Task AbandonPlaybackAdmissionAsync(string admissionId, TransportSnapshot transport)
    {
        using var cleanupDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await SendAsync<object>(
                    HttpMethod.Delete,
                    $"/api/v1/playback-sessions/{Uri.EscapeDataString(admissionId)}",
                    null,
                    cleanupDeadline.Token,
                    notFoundIsSuccess: true,
                    methodNotAllowedIsSuccess: true,
                    transport: transport)
                .ConfigureAwait(false);
        }
        catch (Exception e)
        {
            // Cleanup must never replace the admission failure/cancellation observed by Jellyfin.
            _logger.LogDebug("Playback admission cleanup failed ({FailureType})", e.GetType().Name);
        }
    }

    /// <summary>
    /// Capability-token-bound repair status for a live session. Best-effort observability:
    /// a missing/closed session or older Core yields null, never an exception surface that
    /// could touch playback. The token itself is never logged.
    /// </summary>
    public async Task<SessionRepairStatusDto?> GetSessionRepairStatusAsync(string token, CancellationToken ct)
    {
        try
        {
            return StreamarrPayloadBounds.Normalize(await SendAsync<SessionRepairStatusDto>(
                    HttpMethod.Get,
                    $"/api/v1/sessions/{Uri.EscapeDataString(token)}/repair",
                    null,
                    ct,
                    notFoundIsSuccess: true)
                .ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Opens the full-speed, unpaced download capability for a live Core session — the
    /// <c>GET /api/v1/download/{token}</c> sibling of the paced playback stream. Always
    /// targets the internal/configured Core base URL, never the public stream URL: the
    /// caller proxies these bytes itself (BRIEF client-agnostic download) rather than
    /// redirecting a client to Core directly. The returned response has its headers read but
    /// its content left unbuffered so the caller can copy the body straight through.
    /// </summary>
    public async Task<HttpResponseMessage> OpenDownloadAsync(
        string token,
        string? rangeHeader,
        CancellationToken ct)
    {
        var transport = CaptureTransport();
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{transport.BaseUrl}/api/v1/download/{Uri.EscapeDataString(token)}");
        if (!string.IsNullOrWhiteSpace(transport.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", transport.ApiKey);
        if (!string.IsNullOrWhiteSpace(rangeHeader))
            request.Headers.TryAddWithoutValidation("Range", rangeHeader);

        return await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
    }

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
    /// Appends client-observed TTFF spans (Jellyfin PlaybackInfo→first frame) to a live Core
    /// session's timeline so the stream-page flamegraph spans both processes. Best-effort: a
    /// missing/closed session is treated as success and never disrupts playback.
    /// </summary>
    public async Task ReportTimelineAsync(string token, ClientTimelineRequest timeline, CancellationToken ct)
        => await SendAsync<object>(
                HttpMethod.Post,
                $"/api/v1/sessions/{Uri.EscapeDataString(token)}/timeline",
                timeline,
                ct,
                notFoundIsSuccess: true)
            .ConfigureAwait(false);

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
        return IsCapabilityToken(path.AsSpan(prefix.Length));
    }

    private static bool IsCapabilityToken(ReadOnlySpan<char> token)
        => token.Length is > 0 and <= 256
           && token.IndexOfAnyExcept("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".AsSpan()) < 0;

    private static bool HasCloseableStreamCapability(ResolveResponse response)
        => !string.Equals(response.Status, "dead", StringComparison.OrdinalIgnoreCase)
           && TokenFromStreamUrl(response.StreamUrl) is { } token
           && IsCapabilityToken(token);

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
        bool notFoundIsSuccess = false,
        bool methodNotAllowedIsSuccess = false,
        bool retryTransient = false,
        TransportSnapshot? transport = null)
        where T : class
    {
        const int maxAttempts = 3;
        var requestTransport = transport ?? CaptureTransport();
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await SendOnceAsync<T>(
                        method,
                        path,
                        body,
                        ct,
                        notFoundIsSuccess,
                        methodNotAllowedIsSuccess,
                        requestTransport)
                    .ConfigureAwait(false);
            }
            catch (StreamarrApiException ex) when (
                retryTransient
                && attempt < maxAttempts
                && IsTransient(ex.StatusCode))
            {
                await WaitToRetryAsync(method, path, attempt, maxAttempts, ex.RetryAfter, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException) when (retryTransient && attempt < maxAttempts)
            {
                await WaitToRetryAsync(method, path, attempt, maxAttempts, retryAfter: null, ct).ConfigureAwait(false);
            }
        }
    }

    private async Task<T?> SendOnceAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        CancellationToken ct,
        bool notFoundIsSuccess,
        bool methodNotAllowedIsSuccess,
        TransportSnapshot transport)
        where T : class
    {
        using var request = new HttpRequestMessage(method, transport.BaseUrl + path);
        if (!string.IsNullOrWhiteSpace(transport.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", transport.ApiKey);
        if (body is not null)
            request.Content = JsonContent.Create(body, options: JsonOptions);

        // Stream response bodies so the endpoint-specific readers enforce their byte
        // ceilings before HttpClient can buffer an entire untrusted Core response.
        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            ct).ConfigureAwait(false);
        if ((notFoundIsSuccess && response.StatusCode == System.Net.HttpStatusCode.NotFound)
            || (methodNotAllowedIsSuccess && response.StatusCode == System.Net.HttpStatusCode.MethodNotAllowed))
        {
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            // Session and admission instance URLs contain bearer capabilities. Never accept or
            // log a peer-provided error body for those requests because it could reflect the token.
            var capabilityRequest = path.StartsWith("/api/v1/sessions/", StringComparison.OrdinalIgnoreCase)
                                    || path.StartsWith(
                                        "/api/v1/playback-sessions/",
                                        StringComparison.OrdinalIgnoreCase);
            var detail = capabilityRequest
                ? "capability_request_failed"
                : await ReadErrorAsync(response, ct).ConfigureAwait(false);
            _logger.LogWarning(
                "Streamarr API {Method} {Path} failed: {Status} {Detail}",
                method, SafeLogPath(path), (int)response.StatusCode, detail);
            throw new StreamarrApiException(response.StatusCode, detail, RetryAfter(response));
        }

        if (typeof(T) == typeof(object))
            return null;

        var payload = await ReadBoundedAsync(response.Content, MaxApiResponseBytes, ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<T>(payload, JsonOptions);
    }

    /// <summary>Upper bound on any single retry wait, so a large Core-advertised Retry-After cannot stall a caller past reason.</summary>
    private static readonly TimeSpan MaxRetryDelay = TimeSpan.FromSeconds(5);

    private async Task WaitToRetryAsync(
        HttpMethod method,
        string path,
        int attempt,
        int maxAttempts,
        TimeSpan? retryAfter,
        CancellationToken ct)
    {
        // Core's SearchConcurrencyGate rejects with an explicit Retry-After (e.g. 1s) when it is
        // momentarily at capacity. Retrying on a fixed, much shorter backoff instead of honoring
        // that hint just re-hits the same full gate and burns through the attempt budget for
        // nothing — exactly the kind of transient failure that should have quietly succeeded on
        // the next try. Only fall back to jittered exponential backoff when Core gave no hint.
        var delay = retryAfter is { } advertised && advertised > TimeSpan.Zero
            ? (advertised < MaxRetryDelay ? advertised : MaxRetryDelay)
            : TimeSpan.FromMilliseconds(Math.Min(250 * Math.Pow(2, attempt - 1), 2_000));
        _logger.LogDebug(
            "Streamarr API {Method} {Path} transient failure; retrying (attempt {Attempt}/{Max}) after {DelayMs} ms",
            method,
            SafeLogPath(path),
            attempt,
            maxAttempts,
            (int)delay.TotalMilliseconds);
        await _delay(delay, ct).ConfigureAwait(false);
    }

    private static bool IsTransient(System.Net.HttpStatusCode statusCode)
        => statusCode is System.Net.HttpStatusCode.RequestTimeout
            or System.Net.HttpStatusCode.TooManyRequests
           || (int)statusCode >= 500;

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

    internal static string SafeLogPath(string path)
    {
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        var pathOnly = queryIndex < 0 ? path : path[..queryIndex];
        if (pathOnly.StartsWith("/api/v1/sessions/", StringComparison.OrdinalIgnoreCase))
        {
            if (pathOnly.EndsWith("/repair", StringComparison.OrdinalIgnoreCase))
                return "/api/v1/sessions/{session}/repair";
            if (pathOnly.EndsWith("/timeline", StringComparison.OrdinalIgnoreCase))
                return "/api/v1/sessions/{session}/timeline";
            return "/api/v1/sessions/{session}/close";
        }

        if (pathOnly.StartsWith("/api/v1/playback-sessions/", StringComparison.OrdinalIgnoreCase))
        {
            return pathOnly.EndsWith("/claim", StringComparison.OrdinalIgnoreCase)
                ? "/api/v1/playback-sessions/{admission}/claim"
                : "/api/v1/playback-sessions/{admission}";
        }

        return pathOnly;
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
public sealed class StreamarrApiException(
    System.Net.HttpStatusCode statusCode,
    string detail,
    TimeSpan? retryAfter = null)
    : Exception($"Streamarr Core Server returned {(int)statusCode}: {detail}")
{
    public System.Net.HttpStatusCode StatusCode { get; } = statusCode;

    /// <summary>Core's advertised Retry-After delay, when present on a transient (429/503) response.</summary>
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
