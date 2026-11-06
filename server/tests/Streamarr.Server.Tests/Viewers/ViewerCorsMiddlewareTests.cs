using Microsoft.AspNetCore.Http;
using Streamarr.Server.Options;
using Streamarr.Server.Viewers;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>The production CORS middleware itself (Dev World's own wrapper echoes any requested header and would hide gaps).</summary>
public sealed class ViewerCorsMiddlewareTests
{
    private static async Task<HttpContext> SendAsync(string method, string path, string? requestedHeaders = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Request.Headers.Origin = "https://watch.example";
        if (requestedHeaders is not null)
        {
            context.Request.Headers.AccessControlRequestMethod = "GET";
            context.Request.Headers.AccessControlRequestHeaders = requestedHeaders;
        }
        var middleware = new ViewerCorsMiddleware(_ => Task.CompletedTask,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { ViewerCorsOrigins = ["https://watch.example"] }));
        await middleware.InvokeAsync(context);
        return context;
    }

    private static IEnumerable<string> List(string value) => value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public async Task APreflightForAResumableDownload_AllowsTheConditionalHeaders()
    {
        var context = await SendAsync("OPTIONS", $"/api/v1/offline/{new string('a', 64)}", "range,if-range,if-none-match,if-match");

        Assert.Equal(StatusCodes.Status204NoContent, context.Response.StatusCode);
        var allowed = List(context.Response.Headers.AccessControlAllowHeaders.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Superset(new HashSet<string>(["Range", "If-Range", "If-None-Match", "If-Match"], StringComparer.OrdinalIgnoreCase), allowed);
        Assert.Equal("https://watch.example", context.Response.Headers.AccessControlAllowOrigin.ToString());
    }

    [Fact]
    public async Task AFileAnswer_ExposesTheHeadersADownloaderReads()
    {
        var context = await SendAsync("GET", $"/api/v1/offline/{new string('a', 64)}");

        var exposed = List(context.Response.Headers.AccessControlExposeHeaders.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Superset(new HashSet<string>(["ETag", "Content-Range", "Accept-Ranges", "Content-Length", "Retry-After"], StringComparer.OrdinalIgnoreCase), exposed);
    }
}
