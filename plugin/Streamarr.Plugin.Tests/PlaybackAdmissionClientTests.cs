using System.Collections.Concurrent;
using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin.Tests;

public class PlaybackAdmissionClientTests
{
    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private static string PreparingJson(string admissionId = "admission-1")
        => "{\"admissionId\":\"" + admissionId
           + "\",\"phase\":\"preparing\",\"retryAfterSeconds\":1}";

    private static string ReadyJson(string streamToken, string admissionId = "admission-1")
        => "{\"admissionId\":\"" + admissionId
           + "\",\"phase\":\"ready\",\"resolve\":{\"releaseId\":\"release-1\","
           + "\"status\":\"ready\",\"streamUrl\":\"/api/v1/stream/" + streamToken
           + "\",\"sessionTtlSeconds\":60}}";

    private static StreamarrApiClient Api(
        HttpMessageHandler handler,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
        => new(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            delay);

    [Fact]
    public async Task Ready_admission_is_polled_then_claimed_before_its_capability_is_used()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            return Task.FromResult(path switch
            {
                "/api/v1/playback-sessions" => Json(HttpStatusCode.Accepted, PreparingJson()),
                "/api/v1/playback-sessions/admission-1" when request.Method == HttpMethod.Get
                    => Json(HttpStatusCode.OK, ReadyJson("polled-token")),
                "/api/v1/playback-sessions/admission-1/claim"
                    => Json(HttpStatusCode.OK, ReadyJson("claimed-token")),
                _ => new HttpResponseMessage(HttpStatusCode.NotFound),
            });
        });

        var result = await Api(handler, (_, _) => Task.CompletedTask).AdmitPlaybackAsync(
            "release-1",
            "work-1",
            "user-1",
            "User",
            CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("/api/v1/stream/claimed-token", result!.StreamUrl);
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v1/playback-sessions"),
                (HttpMethod.Get, "/api/v1/playback-sessions/admission-1"),
                (HttpMethod.Post, "/api/v1/playback-sessions/admission-1/claim"),
            ],
            requests.ToArray());
    }

    [Fact]
    public async Task Transient_status_failure_is_retried_without_abandoning_healthy_admission()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var statusAttempts = 0;
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            if (path == "/api/v1/playback-sessions")
                return Task.FromResult(Json(HttpStatusCode.Accepted, PreparingJson()));
            if (path == "/api/v1/playback-sessions/admission-1" && request.Method == HttpMethod.Get)
            {
                statusAttempts++;
                return Task.FromResult(statusAttempts == 1
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : Json(HttpStatusCode.OK, ReadyJson("polled-token")));
            }
            if (path.EndsWith("/claim", StringComparison.Ordinal))
                return Task.FromResult(Json(HttpStatusCode.OK, ReadyJson("claimed-token")));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        });

        var result = await Api(handler, (_, _) => Task.CompletedTask).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None);

        Assert.Equal("/api/v1/stream/claimed-token", result!.StreamUrl);
        Assert.Equal(2, statusAttempts);
        Assert.DoesNotContain(requests, request => request.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task Admission_lifecycle_pins_one_core_origin_and_api_key()
    {
        var observed = new ConcurrentQueue<(string Host, string? ApiKey)>();
        var handler = new CallbackHandler((request, _) =>
        {
            observed.Enqueue((request.RequestUri!.Host, request.Headers.Authorization?.Parameter));
            var path = request.RequestUri.AbsolutePath;
            return Task.FromResult(path switch
            {
                "/api/v1/playback-sessions" => Json(HttpStatusCode.Accepted, PreparingJson()),
                "/api/v1/playback-sessions/admission-1" => Json(HttpStatusCode.OK, ReadyJson("polled-token")),
                "/api/v1/playback-sessions/admission-1/claim" => Json(HttpStatusCode.OK, ReadyJson("claimed-token")),
                _ => new HttpResponseMessage(HttpStatusCode.NotFound),
            });
        });
        var oldConfig = new PluginConfiguration { ServerUrl = "https://old-core.example", ApiKey = "old-key" };
        var newConfig = new PluginConfiguration { ServerUrl = "https://new-core.example", ApiKey = "new-key" };
        var reads = 0;
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => Interlocked.Increment(ref reads) == 1 ? oldConfig : newConfig,
            (_, _) => Task.CompletedTask);

        var result = await api.AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None);

        Assert.Equal("/api/v1/stream/claimed-token", result!.StreamUrl);
        Assert.Equal(1, reads);
        Assert.All(observed, request => Assert.Equal(("old-core.example", "old-key"), request));
    }

    [Fact]
    public async Task Legacy_core_without_admissions_falls_back_to_resolve()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            return Task.FromResult(path == "/api/v1/playback-sessions"
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : Json(
                    HttpStatusCode.OK,
                    """{"releaseId":"release-1","status":"ready","streamUrl":"/api/v1/stream/legacy-token"}"""));
        });

        var result = await Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("/api/v1/stream/legacy-token", result!.StreamUrl);
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v1/playback-sessions"),
                (HttpMethod.Post, "/api/v1/resolve"),
            ],
            requests.ToArray());
    }

    [Fact]
    public async Task Missing_claim_endpoint_rejects_and_abandons_unowned_admission()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            if (path.EndsWith("/claim", StringComparison.Ordinal))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            if (request.Method == HttpMethod.Delete)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            return Task.FromResult(Json(HttpStatusCode.OK, ReadyJson("unclaimed-token")));
        });

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Contains("playback_admission_claim_unsupported", error.Message, StringComparison.Ordinal);
        Assert.Equal(
            [
                (HttpMethod.Post, "/api/v1/playback-sessions"),
                (HttpMethod.Post, "/api/v1/playback-sessions/admission-1/claim"),
                (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            ],
            requests.ToArray());
    }

    [Fact]
    public async Task Cancellation_after_receiving_an_admission_id_uses_independent_cleanup_token()
    {
        var caller = new CancellationTokenSource();
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path, bool WasCancelled)>();
        var handler = new CallbackHandler((request, requestToken) =>
        {
            requests.Enqueue((request.Method, request.RequestUri!.AbsolutePath, requestToken.IsCancellationRequested));
            return Task.FromResult(request.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.NoContent)
                : Json(HttpStatusCode.Accepted, PreparingJson()));
        });
        var api = Api(handler, (_, token) =>
        {
            caller.Cancel();
            return Task.Delay(Timeout.InfiniteTimeSpan, token);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => api.AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            caller.Token));

        var cleanup = Assert.Single(requests, request => request.Method == HttpMethod.Delete);
        Assert.Equal("/api/v1/playback-sessions/admission-1", cleanup.Path);
        Assert.False(cleanup.WasCancelled);
    }

    [Fact]
    public async Task Claim_failure_best_effort_deletes_the_unowned_admission()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            if (request.Method == HttpMethod.Delete)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            if (path.EndsWith("/claim", StringComparison.Ordinal))
            {
                return Task.FromResult(Json(
                    HttpStatusCode.InternalServerError,
                    """{"error":{"code":"claim_failed","message":"reflected admission-1"}}"""));
            }

            return Task.FromResult(Json(HttpStatusCode.OK, ReadyJson("unowned-token")));
        });

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Equal(HttpStatusCode.InternalServerError, error.StatusCode);
        Assert.Contains("capability_request_failed", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("admission-1", error.Message, StringComparison.Ordinal);
        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    [Fact]
    public async Task Dead_resolve_is_returned_for_core_selected_fallback_after_abandoning_admission()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            requests.Enqueue((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(request.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.NoContent)
                : Json(
                    HttpStatusCode.OK,
                    """
                    {"admissionId":"admission-1","phase":"failed","resolve":{"releaseId":"release-1","status":"dead","suggestedFallbackReleaseId":"release-2"}}
                    """));
        });

        var result = await Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal("dead", result!.Status);
        Assert.Equal("release-2", result.SuggestedFallbackReleaseId);
        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    [Fact]
    public async Task Failed_phase_with_ready_capability_is_rejected_and_abandoned()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            requests.Enqueue((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(request.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.NoContent)
                : Json(
                    HttpStatusCode.OK,
                    """{"admissionId":"admission-1","phase":"failed","resolve":{"releaseId":"release-1","status":"ready","streamUrl":"/api/v1/stream/revoked-token"}}"""));
        });

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Contains("invalid_failed_playback_admission_resolve", error.Message, StringComparison.Ordinal);
        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    [Fact]
    public async Task Claimed_ready_response_without_closeable_capability_is_rejected_and_abandoned()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            requests.Enqueue((request.Method, path));
            if (request.Method == HttpMethod.Delete)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            return Task.FromResult(path.EndsWith("/claim", StringComparison.Ordinal)
                ? Json(
                    HttpStatusCode.OK,
                    """{"admissionId":"admission-1","phase":"ready","resolve":{"releaseId":"release-1","status":"ready"}}""")
                : Json(HttpStatusCode.OK, ReadyJson("polled-token")));
        });

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Contains("invalid_playback_admission_claim", error.Message, StringComparison.Ordinal);
        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    [Fact]
    public async Task Polled_ready_response_without_closeable_capability_is_not_claimed_and_is_abandoned()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            requests.Enqueue((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(request.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.NoContent)
                : Json(
                    HttpStatusCode.OK,
                    """{"admissionId":"admission-1","phase":"ready","resolve":{"releaseId":"release-1","status":"ready","streamUrl":"/api/v1/stream/not closeable"}}"""));
        });

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Contains("invalid_ready_playback_admission_resolve", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(requests, request => request.Path.EndsWith("/claim", StringComparison.Ordinal));
        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    [Fact]
    public async Task Malformed_envelope_with_valid_id_is_still_abandoned()
    {
        var requests = new ConcurrentQueue<(HttpMethod Method, string Path)>();
        var handler = new CallbackHandler((request, _) =>
        {
            requests.Enqueue((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(request.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.NoContent)
                : Json(
                    HttpStatusCode.OK,
                    """{"admissionId":"admission-1","phase":"unexpected"}"""));
        });

        await Assert.ThrowsAsync<StreamarrApiException>(() => Api(handler).AdmitPlaybackAsync(
            "release-1",
            null,
            null,
            null,
            CancellationToken.None));

        Assert.Contains(
            (HttpMethod.Delete, "/api/v1/playback-sessions/admission-1"),
            requests);
    }

    private sealed class CallbackHandler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => callback(request, cancellationToken);
    }
}
