using System.Net;
using System.Text;
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
