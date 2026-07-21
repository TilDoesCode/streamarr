using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin.Tests;

public class ApiClientSecurityTests
{
    [Fact]
    public async Task Connection_test_rejects_wrong_machine_key_even_when_public_health_succeeds()
    {
        var paths = new List<string>();
        var handler = new CallbackHandler(request =>
        {
            paths.Add(request.RequestUri!.AbsolutePath);
            if (request.RequestUri.AbsolutePath == "/api/v1/health")
                return Json(HttpStatusCode.OK, "{\"status\":\"healthy\",\"version\":\"test\"}");

            Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
            Assert.Equal("wrong-key", request.Headers.Authorization?.Parameter);
            return Json(
                HttpStatusCode.Unauthorized,
                "{\"error\":{\"code\":\"unauthorized\",\"message\":\"Invalid API key\"}}");
        });
        var config = new PluginConfiguration
        {
            ServerUrl = "https://core.example",
            ApiKey = "wrong-key",
        };
        var api = new StreamarrApiClient(new HttpClient(handler), NullLogger<StreamarrApiClient>.Instance, () => config);

        var error = await Assert.ThrowsAsync<StreamarrApiException>(() => api.TestConnectionAsync(CancellationToken.None));

        Assert.Equal(HttpStatusCode.Unauthorized, error.StatusCode);
        Assert.Equal(["/api/v1/health", "/api/v1/caps"], paths);
    }

    [Fact]
    public async Task Api_response_is_rejected_before_deserializing_past_byte_limit()
    {
        var handler = new CallbackHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(new byte[StreamarrApiClient.MaxApiResponseBytes + 1]),
        });
        var config = new PluginConfiguration { ServerUrl = "https://core.example" };
        var api = new StreamarrApiClient(new HttpClient(handler), NullLogger<StreamarrApiClient>.Instance, () => config);

        await Assert.ThrowsAsync<InvalidDataException>(() => api.GetHealthAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Search_forwards_unambiguous_media_type_and_escapes_query()
    {
        Uri? requested = null;
        var handler = new CallbackHandler(request =>
        {
            requested = request.RequestUri;
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });
        var config = new PluginConfiguration { ServerUrl = "https://core.example" };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config);

        _ = await api.SearchAsync("Dune 2 & more", "movie", CancellationToken.None);

        Assert.NotNull(requested);
        Assert.Equal("Dune 2 & more", System.Web.HttpUtility.ParseQueryString(requested!.Query)["q"]);
        Assert.Equal("movie", System.Web.HttpUtility.ParseQueryString(requested.Query)["type"]);
    }

    [Fact]
    public async Task Search_retries_transient_core_failure_before_returning_results()
    {
        var calls = 0;
        var handler = new CallbackHandler(_ => Interlocked.Increment(ref calls) == 1
            ? Json(HttpStatusCode.ServiceUnavailable, "{\"error\":{\"code\":\"temporary\",\"message\":\"retry\"}}")
            : Json(HttpStatusCode.OK, "{\"results\":[]}"));
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            (_, _) => Task.CompletedTask);

        var result = await api.SearchAsync("Dune", "movie", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Search_does_not_retry_permanent_core_failure()
    {
        var calls = 0;
        var handler = new CallbackHandler(_ =>
        {
            Interlocked.Increment(ref calls);
            return Json(HttpStatusCode.BadRequest, "{\"error\":{\"code\":\"bad\",\"message\":\"bad\"}}");
        });
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            (_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<StreamarrApiException>(
            () => api.SearchAsync("Dune", "movie", CancellationToken.None));

        Assert.Equal(1, calls);
    }

    [Theory]
    [InlineData("episode")]
    [InlineData("tv")]
    public async Task Persisted_tv_refresh_uses_stable_series_and_episode_coordinates(string mediaType)
    {
        Uri? requested = null;
        var handler = new CallbackHandler(request =>
        {
            requested = request.RequestUri;
            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });
        var config = new PluginConfiguration
        {
            ServerUrl = "https://core.example",
            ProfileId = "german hd",
        };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config);

        _ = await api.RefreshWorkAsync(new WorkDto
        {
            WorkId = "tmdb-tv-37680-s01e02",
            MediaType = mediaType,
            Title = "Suits",
            TmdbId = 37680,
            Season = 1,
            Episode = 2,
        }, CancellationToken.None);

        Assert.NotNull(requested);
        var query = System.Web.HttpUtility.ParseQueryString(requested!.Query);
        Assert.Null(query["q"]);
        Assert.Equal("37680", query["tmdbId"]);
        Assert.Equal("tv", query["type"]);
        Assert.Equal("1", query["season"]);
        Assert.Equal("2", query["episode"]);
        Assert.Equal("german hd", query["profileId"]);
    }

    [Fact]
    public async Task Tv_hierarchy_uses_bounded_discovery_and_profiled_season_routes()
    {
        var requested = new List<Uri>();
        var handler = new CallbackHandler(request =>
        {
            requested.Add(request.RequestUri!);
            return request.RequestUri!.AbsolutePath.EndsWith("/seasons/2", StringComparison.Ordinal)
                ? Json(HttpStatusCode.OK, "{\"series\":{},\"season\":{},\"episodes\":[]}")
                : Json(HttpStatusCode.OK, "{\"results\":[]}");
        });
        var config = new PluginConfiguration
        {
            ServerUrl = "https://core.example",
            ProfileId = "german hd",
        };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config);

        _ = await api.SearchTvSeriesAsync("Suits & more", CancellationToken.None);
        _ = await api.GetTvSeasonAsync(37680, 2, CancellationToken.None);

        Assert.Equal(2, requested.Count);
        Assert.Equal("Suits & more", System.Web.HttpUtility.ParseQueryString(requested[0].Query)["q"]);
        Assert.Equal("3", System.Web.HttpUtility.ParseQueryString(requested[0].Query)["limit"]);
        Assert.Equal("/api/v1/tv/37680/seasons/2", requested[1].AbsolutePath);
        Assert.Equal("german hd", System.Web.HttpUtility.ParseQueryString(requested[1].Query)["profileId"]);
    }

    [Fact]
    public async Task Resolve_forwards_the_episode_work_that_offered_a_multi_episode_release()
    {
        string? body = null;
        var handler = new CallbackHandler(request =>
        {
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return Json(HttpStatusCode.OK, "{\"releaseId\":\"multi\",\"status\":\"dead\"}");
        });
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => new PluginConfiguration { ServerUrl = "https://core.example" });

        _ = await api.ResolveAsync("multi", "tmdb-tv-1-s01e02", CancellationToken.None);

        using var document = JsonDocument.Parse(body!);
        Assert.Equal("multi", document.RootElement.GetProperty("releaseId").GetString());
        Assert.Equal("tmdb-tv-1-s01e02", document.RootElement.GetProperty("workId").GetString());
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }
}
