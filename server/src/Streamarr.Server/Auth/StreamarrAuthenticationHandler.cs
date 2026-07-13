using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using StreamarrOpts = Streamarr.Server.Options.StreamarrOptions;

namespace Streamarr.Server.Auth;

/// <summary>
/// The single authentication scheme for the two-mode auth model (BRIEF §6.4). Both modes
/// arrive as <c>Authorization: Bearer &lt;token&gt;</c>:
/// <list type="bullet">
/// <item>a machine API key (the static bootstrap key or one minted via the config API) →
/// a principal in the <see cref="AuthRoles.Machine"/> role, scoped to
/// search/resolve/stream/events/caps by the absence of the admin role;</item>
/// <item>an admin session JWT from <c>POST /api/v1/auth/login</c> → a principal in the
/// <see cref="AuthRoles.Admin"/> role, allowed everywhere including /config and /debug.</item>
/// </list>
/// API keys are tried first (a cheap hash lookup); anything else is validated as a JWT.
/// </summary>
public sealed class StreamarrAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> optionsMonitor,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IOptionsMonitor<StreamarrOpts> streamarrOptions,
    ApiKeyService apiKeys,
    JwtTokenService jwt) : AuthenticationHandler<AuthenticationSchemeOptions>(optionsMonitor, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        const string scheme = "Bearer ";
        if (!header.StartsWith(scheme, StringComparison.Ordinal))
            return Task.FromResult(AuthenticateResult.NoResult());

        var token = header[scheme.Length..].Trim();
        if (token.Length == 0)
            return Task.FromResult(AuthenticateResult.NoResult());

        // 1) machine API key (static bootstrap or minted).
        if (IsMachineKey(token))
            return Task.FromResult(Success(MachinePrincipal()));

        // 2) admin session JWT.
        var principal = jwt.Validate(token);
        if (principal is not null)
            return Task.FromResult(Success(new ClaimsPrincipal(new ClaimsIdentity(principal.Claims, AuthRoles.Scheme))));

        return Task.FromResult(AuthenticateResult.Fail("Invalid or expired bearer token."));
    }

    private bool IsMachineKey(string token)
    {
        var staticKey = streamarrOptions.CurrentValue.ApiKey;
        if (!string.IsNullOrEmpty(staticKey) &&
            CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(staticKey)))
        {
            return true;
        }

        return apiKeys.IsValid(token);
    }

    private static ClaimsPrincipal MachinePrincipal()
    {
        var identity = new ClaimsIdentity(
        [
            new Claim(ClaimTypes.Name, "machine"),
            new Claim(ClaimTypes.Role, AuthRoles.Machine),
        ], AuthRoles.Scheme);
        return new ClaimsPrincipal(identity);
    }

    private AuthenticateResult Success(ClaimsPrincipal principal)
        => AuthenticateResult.Success(new AuthenticationTicket(principal, AuthRoles.Scheme));

    /// <summary>401 for missing/invalid credentials, with the shared error envelope.</summary>
    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.WWWAuthenticate = "Bearer";
        Response.ContentType = "application/json";
        await Response.WriteAsJsonAsync(
            ErrorResponse.Of("unauthorized", "Valid credentials are required (machine API key or admin session)."));
    }

    /// <summary>403 when an authenticated machine key reaches an admin-only endpoint.</summary>
    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status403Forbidden;
        Response.ContentType = "application/json";
        await Response.WriteAsJsonAsync(
            ErrorResponse.Of("forbidden", "This endpoint requires an admin session; machine API keys are not permitted."));
    }
}
