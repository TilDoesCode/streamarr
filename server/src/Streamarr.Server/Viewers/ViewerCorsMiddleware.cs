using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Viewers;

/// <summary>CORS for viewer apps on configured origins: the viewer API and the capability URLs, without credentials; the admin API stays same-origin.</summary>
public sealed class ViewerCorsMiddleware(RequestDelegate next, IOptions<StreamarrOptions> options)
{
    public static readonly string[] Prefixes = ["/api/v1/viewer", "/api/v1/stream", "/api/v1/transcode"];

    private const string ExposedHeaders = "Content-Length, Content-Range, Accept-Ranges, Content-Type, Retry-After, Location, ETag";

    private readonly bool _anyOrigin = options.Value.ViewerCorsOrigins.Any(o => o.Trim() == "*");

    private readonly HashSet<string> _origins = options.Value.ViewerCorsOrigins
        .Select(o => Uri.TryCreate(o.Trim(), UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? Normalize(uri) : null)
        .OfType<string>()
        .ToHashSet(StringComparer.Ordinal);

    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        var origin = request.Headers.Origin.ToString();
        if (origin.Length == 0 || !Prefixes.Any(p => request.Path.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase)) || !Allowed(origin))
        {
            await next(context);
            return;
        }

        var headers = context.Response.Headers;
        headers.AccessControlAllowOrigin = _anyOrigin ? "*" : origin;
        headers.Append("Vary", "Origin");
        headers.AccessControlExposeHeaders = ExposedHeaders;
        if (HttpMethods.IsOptions(request.Method) && request.Headers.AccessControlRequestMethod.Count > 0)
        {
            headers.AccessControlAllowMethods = "GET, HEAD, POST, PUT, PATCH, DELETE";
            headers.AccessControlAllowHeaders = "Authorization, Content-Type, Range, Accept-Language";
            headers.AccessControlMaxAge = "600";
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            return;
        }
        await next(context);
    }

    private bool Allowed(string origin)
        => _anyOrigin || (Uri.TryCreate(origin, UriKind.Absolute, out var uri) && _origins.Contains(Normalize(uri)));

    private static string Normalize(Uri uri) => $"{uri.Scheme.ToLowerInvariant()}://{uri.IdnHost.ToLowerInvariant()}:{uri.Port}";
}
