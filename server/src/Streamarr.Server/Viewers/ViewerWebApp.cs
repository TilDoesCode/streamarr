using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Viewers;

/// <summary>
/// Serves the exported viewer web app (Expo web export of client/) under <c>/watch</c> with an SPA fallback.
/// Anonymous like the Management SPA shell; the viewer API behind it stays auth-gated.
/// </summary>
public static class ViewerWebApp
{
    public const string PathPrefix = "/watch";
    public const string DefaultDirectoryName = "viewer-web";

    private const string ImmutableCache = "public, max-age=31536000, immutable";
    private const string NoCache = "no-cache";

    internal const string ContentSecurityPolicy =
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://image.tmdb.org; " +
        "media-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:";

    public static string ResolveDirectory(string? configured, string contentRootPath) =>
        string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(contentRootPath, DefaultDirectoryName)
            : Path.GetFullPath(configured, contentRootPath);

    /// <summary>Maps <c>/watch</c> when the viewer export exists; must run before the Management SPA and auth.</summary>
    public static WebApplication UseStreamarrViewerWeb(this WebApplication app)
    {
        var root = ResolveDirectory(
            app.Services.GetRequiredService<IOptions<StreamarrOptions>>().Value.ViewerWebPath,
            app.Environment.ContentRootPath);
        if (!File.Exists(Path.Combine(root, "index.html")))
            return app;

        var files = new PhysicalFileProvider(root);
        app.Map(PathPrefix, branch =>
        {
            branch.Use(async (context, next) =>
            {
                // Overrides the Management UI policy set by the global header middleware.
                var headers = context.Response.Headers;
                headers["Content-Security-Policy"] = ContentSecurityPolicy;
                headers.XContentTypeOptions = "nosniff";
                headers["Referrer-Policy"] = "no-referrer";

                if (!context.Request.Path.HasValue)
                {
                    context.Response.Redirect($"{context.Request.PathBase}/{context.Request.QueryString}");
                    return;
                }

                await next();
            });
            branch.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = files,
                OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl =
                    IsHashedAsset(ctx.Context.Request.Path) ? ImmutableCache : NoCache,
            });
            branch.Run(async context =>
            {
                var request = context.Request;
                // Client-side routes have no extension; a missing asset must stay a 404, never the shell.
                if (!(HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)) ||
                    Path.HasExtension(request.Path.Value))
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                var index = files.GetFileInfo("index.html");
                if (!index.Exists)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                context.Response.ContentType = "text/html; charset=utf-8";
                context.Response.Headers.CacheControl = NoCache;
                context.Response.ContentLength = index.Length;
                if (HttpMethods.IsGet(request.Method))
                    await context.Response.SendFileAsync(index, context.RequestAborted);
            });
        });
        return app;
    }

    private static bool IsHashedAsset(PathString path) =>
        path.StartsWithSegments("/_expo", StringComparison.OrdinalIgnoreCase) ||
        path.StartsWithSegments("/assets", StringComparison.OrdinalIgnoreCase);
}
