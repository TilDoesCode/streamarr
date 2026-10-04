using Microsoft.AspNetCore.Http;

namespace Streamarr.Server.Security;

/// <summary>Every /api response (tokens, codes, secrets, stream URLs, personal data) is private and never stored, whatever an endpoint sets.</summary>
public static class NoStoreApiResponses
{
    public const string CacheControl = "private, no-store, max-age=0";

    public static bool Covers(PathString path) => path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase);

    public static void Apply(HttpContext context)
    {
        if (!Covers(context.Request.Path))
            return;

        Stamp(context.Response.Headers);
        context.Response.OnStarting(static state =>
        {
            Stamp(((HttpResponse)state).Headers);
            return Task.CompletedTask;
        }, context.Response);
    }

    private static void Stamp(IHeaderDictionary headers)
    {
        headers.CacheControl = CacheControl;
        headers.Pragma = "no-cache";
        headers.Expires = "0";
    }
}
