using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Auth;

/// <summary>
/// Stub bearer authentication for M1: every /api endpoint except the liveness
/// probe requires <c>Authorization: Bearer &lt;api-key&gt;</c>. /stream is never
/// public (BRIEF §6.4) — it goes through this check like everything else.
/// Real machine/admin auth (scopes, JWT admin sessions) lands in M3.
/// </summary>
public sealed class ApiKeyAuthMiddleware(RequestDelegate next, IOptionsMonitor<StreamarrOptions> options)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        if (!path.StartsWithSegments("/api") || path.StartsWithSegments("/api/v1/health"))
        {
            await next(context);
            return;
        }

        var apiKey = options.CurrentValue.ApiKey;
        if (!string.IsNullOrEmpty(apiKey) &&
            IsAuthorized(context.Request.Headers.Authorization.ToString(), apiKey))
        {
            await next(context);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.Headers.WWWAuthenticate = "Bearer";
        await context.Response.WriteAsJsonAsync(
            ErrorResponse.Of("unauthorized", "A valid bearer API key is required."));
    }

    private static bool IsAuthorized(string authorizationHeader, string apiKey)
    {
        const string scheme = "Bearer ";
        if (!authorizationHeader.StartsWith(scheme, StringComparison.Ordinal))
            return false;

        var presented = authorizationHeader[scheme.Length..].Trim();
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(presented),
            Encoding.UTF8.GetBytes(apiKey));
    }
}
