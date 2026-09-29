using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>The frozen OpenAPI contract lists every status the viewer gates and the HLS segment routes really answer.</summary>
public sealed class ViewerContractTests(ViewerCatalogFactory factory) : IClassFixture<ViewerCatalogFactory>
{
    private static readonly string[] SegmentFailures = ["404", "410", "500", "503", "504"];

    private async Task<JsonElement> PathsAsync()
    {
        using var client = factory.CreateClient();
        using var spec = JsonDocument.Parse(await client.GetStringAsync("/openapi/v1.json"));
        return spec.RootElement.GetProperty("paths").Clone();
    }

    private static string[] Statuses(JsonElement paths, string path, string method)
        => paths.GetProperty(path).GetProperty(method).GetProperty("responses").EnumerateObject().Select(p => p.Name).ToArray();

    [Theory]
    [InlineData("/api/v1/transcode/{token}/init.mp4")]
    [InlineData("/api/v1/transcode/{token}/{segment}.m4s")]
    [InlineData("/api/v1/transcode/{token}/subtitles/{stream}/{segment}.vtt")]
    public async Task HlsSegmentRoutes_DeclareEveryFailureTheyCanAnswer(string path)
    {
        var statuses = Statuses(await PathsAsync(), path, "get");

        Assert.All(SegmentFailures, status => Assert.Contains(status, statuses));
    }

    [Theory]
    [InlineData("/api/v1/viewer/catalog/search")]
    [InlineData("/api/v1/viewer/catalog/discover")]
    [InlineData("/api/v1/viewer/watch/resume")]
    [InlineData("/api/v1/viewer/watch/next-up")]
    [InlineData("/api/v1/viewer/watch/history")]
    [InlineData("/api/v1/viewer/playback/{playbackId}")]
    public async Task ViewerEndpoints_DeclareTheGateResponses(string path)
    {
        var statuses = Statuses(await PathsAsync(), path, "get");

        Assert.Contains("401", statuses);
        Assert.Contains("403", statuses);
        Assert.Contains("404", statuses);
    }

    [Fact]
    public async Task EveryViewerEndpoint_DeclaresTheModuleGate404()
    {
        var paths = await PathsAsync();
        var viewerOperations = paths.EnumerateObject()
            .Where(p => p.Name.StartsWith("/api/v1/viewer/", StringComparison.Ordinal))
            .SelectMany(p => p.Value.EnumerateObject().Select(o => (Path: p.Name, Method: o.Name, Responses: o.Value.GetProperty("responses"))))
            .ToList();

        Assert.NotEmpty(viewerOperations);
        Assert.All(viewerOperations, op => Assert.True(op.Responses.TryGetProperty("404", out _), $"{op.Method} {op.Path} lacks 404"));
        Assert.All(viewerOperations.Where(op => !op.Path.StartsWith("/api/v1/viewer/auth/", StringComparison.Ordinal)),
            op => Assert.True(op.Responses.TryGetProperty("401", out _), $"{op.Method} {op.Path} lacks 401"));
    }

    [Fact]
    public async Task ConfiguredViewerOrigins_GetCors_ForTheViewerApiAndCapabilityUrls_ButNotTheAdminApi()
    {
        using var cors = factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ViewerCorsOrigins:0"] = "https://watch.example",
            ["Streamarr:ViewerCorsOrigins:1"] = "",
        })));
        using var client = cors.CreateClient();

        async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string origin, bool preflight = false)
        {
            using var request = new HttpRequestMessage(method, path);
            request.Headers.Add("Origin", origin);
            if (preflight)
            {
                request.Headers.Add("Access-Control-Request-Method", "GET");
                request.Headers.Add("Access-Control-Request-Headers", "authorization");
            }
            return await client.SendAsync(request);
        }

        static string? AllowOrigin(HttpResponseMessage response)
            => response.Headers.TryGetValues("Access-Control-Allow-Origin", out var values) ? values.Single() : null;

        var preflight = await SendAsync(HttpMethod.Options, "/api/v1/viewer/catalog/search?q=x", "https://watch.example", preflight: true);
        Assert.Equal(HttpStatusCode.NoContent, preflight.StatusCode);
        Assert.Equal("https://watch.example", AllowOrigin(preflight));
        Assert.Contains("Authorization", preflight.Headers.GetValues("Access-Control-Allow-Headers").Single());
        Assert.False(preflight.Headers.Contains("Access-Control-Allow-Credentials"));

        var rejected = await SendAsync(HttpMethod.Get, "/api/v1/viewer/catalog/search?q=x", "https://watch.example");
        Assert.Contains(rejected.StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.NotFound });
        Assert.Equal("https://watch.example", AllowOrigin(rejected));
        var segment = await SendAsync(HttpMethod.Get, "/api/v1/transcode/unknown-capability/0.m4s", "https://watch.example");
        Assert.Equal("https://watch.example", AllowOrigin(segment));
        Assert.Contains("Content-Range", segment.Headers.GetValues("Access-Control-Expose-Headers").Single());

        Assert.Null(AllowOrigin(await SendAsync(HttpMethod.Options, "/api/v1/viewer/catalog/search", "https://evil.example", preflight: true)));
        Assert.Null(AllowOrigin(await SendAsync(HttpMethod.Get, "/api/v1/search?q=x", "https://watch.example")));
        using var defaults = factory.CreateClient();
        using var plain = new HttpRequestMessage(HttpMethod.Get, "/api/v1/viewer/catalog/search?q=x");
        plain.Headers.Add("Origin", "https://watch.example");
        Assert.Null(AllowOrigin(await defaults.SendAsync(plain)));
    }

    [Fact]
    public async Task MalformedQueryValues_OnWatchEndpoints_UseTheErrorEnvelope()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var username = $"contract-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(admin, new { username, password = "correct horse battery" });
        using var anon = factory.CreateClient();
        using var viewer = factory.Bearer(await ViewerApi.AccessTokenAsync(anon, username, "correct horse battery"));

        var paths = await PathsAsync();
        Assert.Contains("400", Statuses(paths, "/api/v1/viewer/watch/resume", "get"));
        foreach (var path in new[] { "/api/v1/viewer/watch/resume?limit=abc", "/api/v1/viewer/watch/history?offset=x" })
        {
            var response = await viewer.GetAsync(path);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("invalid_request", body.GetProperty("error").GetProperty("code").GetString());
        }
    }

    [Theory]
    [InlineData("PlaybackResponse", "fallbackFrom", true)]
    [InlineData("PlaybackResponse", "mediaInfo", true)]
    [InlineData("PlaybackResponse", "decision", true)]
    [InlineData("PlaybackResponse", "error", true)]
    [InlineData("PlaybackMediaInfoDto", "video", true)]
    [InlineData("SeriesWatchSummaryDto", "nextEpisode", true)]
    [InlineData("ViewerAuthResponse", "session", true)]
    [InlineData("ErrorResponse", "error", false)]
    [InlineData("CatalogMovieResponse", "watch", false)]
    public async Task ObjectProperties_TheServerSendsAsNull_AreNullableInTheContract(string type, string property, bool nullable)
    {
        using var client = factory.CreateClient();
        using var spec = JsonDocument.Parse(await client.GetStringAsync("/openapi/v1.json"));
        var schema = spec.RootElement.GetProperty("components").GetProperty("schemas").GetProperty(type).GetProperty("properties").GetProperty(property);

        Assert.Equal(nullable, schema.TryGetProperty("nullable", out var flag) && flag.GetBoolean());
        var target = nullable ? schema.GetProperty("allOf")[0] : schema;
        Assert.StartsWith("#/components/schemas/", target.GetProperty("$ref").GetString());
    }
}
