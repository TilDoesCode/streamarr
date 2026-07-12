using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Auth;

/// <summary>
/// Machine bearer authentication (BRIEF §6.4): every /api endpoint except the liveness
/// probe requires <c>Authorization: Bearer &lt;api-key&gt;</c>. Accepts the static
/// bootstrap key from config <em>or</em> any active key minted through the config API.
/// /stream is never public — it goes through this check like everything else.
/// Admin session (JWT) auth for the Management UI is layered on later.
/// </summary>
public sealed class ApiKeyAuthMiddleware(RequestDelegate next, IOptionsMonitor<StreamarrOptions> options, ApiKeyService apiKeys)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        if (!path.StartsWithSegments("/api") || path.StartsWithSegments("/api/v1/health"))
        {
            await next(context);
            return;
        }

        if (IsAuthorized(context.Request.Headers.Authorization.ToString()))
        {
            await next(context);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.Headers.WWWAuthenticate = "Bearer";
        await context.Response.WriteAsJsonAsync(
            ErrorResponse.Of("unauthorized", "A valid bearer API key is required."));
    }

    private bool IsAuthorized(string authorizationHeader)
    {
        const string scheme = "Bearer ";
        if (!authorizationHeader.StartsWith(scheme, StringComparison.Ordinal))
            return false;

        var presented = authorizationHeader[scheme.Length..].Trim();
        if (presented.Length == 0)
            return false;

        var staticKey = options.CurrentValue.ApiKey;
        if (!string.IsNullOrEmpty(staticKey) &&
            CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(staticKey)))
        {
            return true;
        }

        return apiKeys.IsValid(presented);
    }
}
