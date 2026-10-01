using Microsoft.Extensions.Options;
using Microsoft.Net.Http.Headers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Options;

namespace Streamarr.Server.Viewers;

/// <summary>Viewer API requests read TMDB metadata in the viewer's Accept-Language (primary tag); unknown or missing means the server default.</summary>
public sealed class ViewerLanguageMiddleware(RequestDelegate next, IOptions<StreamarrOptions> options)
{
    private readonly HashSet<string> _supported = options.Value.Tmdb.ViewerLanguages
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(TmdbLanguage.Primary)
        .OfType<string>()
        .ToHashSet(StringComparer.Ordinal);

    private readonly string _default = TmdbLanguage.Primary(options.Value.Tmdb.Language) ?? "en";

    public async Task InvokeAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments("/api/v1/viewer", StringComparison.OrdinalIgnoreCase))
        {
            await next(context);
            return;
        }
        context.Response.Headers.Append(HeaderNames.Vary, HeaderNames.AcceptLanguage);
        using var _ = TmdbLanguage.Use(Resolve(context.Request.Headers.AcceptLanguage.ToString()));
        await next(context);
    }

    /// <summary>The TMDB language for an Accept-Language value: null for the server default, else the primary tag.</summary>
    internal string? Resolve(string? acceptLanguage)
    {
        if (string.IsNullOrWhiteSpace(acceptLanguage) || !StringWithQualityHeaderValue.TryParseList([acceptLanguage], out var values))
            return null;
        var best = values
            .Where(v => (v.Quality ?? 1) > 0)
            .OrderByDescending(v => v.Quality ?? 1)
            .Select(v => TmdbLanguage.Primary(v.Value.Value))
            .FirstOrDefault(code => code is not null && _supported.Contains(code));
        return best is null || best == _default ? null : best;
    }
}
