using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Viewers.Auth;

/// <summary>Authenticates viewer access tokens (bearer or HttpOnly cookie); never accepts admin JWTs or machine keys.</summary>
public sealed class ViewerAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> optionsMonitor,
    ILoggerFactory logger,
    UrlEncoder encoder,
    ViewerSettingsService settings,
    ViewerSessionService sessions) : AuthenticationHandler<AuthenticationSchemeOptions>(optionsMonitor, logger, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var fromCookie = false;
        var token = BearerToken();
        if (token is null && Request.Cookies.TryGetValue(ViewerAuth.CookieName, out var cookie))
        {
            token = cookie;
            fromCookie = true;
        }
        if (token is null)
            return AuthenticateResult.NoResult();
        if (!ViewerAuth.HasShape(token, ViewerAuth.AccessTokenPrefix))
            return AuthenticateResult.Fail("Not a viewer access token.");
        if (!(await settings.GetAsync(Context.RequestAborted)).Enabled)
            return AuthenticateResult.Fail("The viewer module is disabled.");

        var identity = await sessions.ValidateAsync(token, Context.RequestAborted);
        if (identity is null)
            return AuthenticateResult.Fail("Invalid or expired viewer session.");

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, identity.Viewer.Id),
            new(ClaimTypes.Name, identity.Viewer.Username),
            new(ClaimTypes.Role, ViewerAuth.Role),
            new(ViewerAuth.AccountTypeClaim, ViewerAuth.AccountType),
            new(ViewerAuth.SessionIdClaim, identity.Session.Id),
            new(ViewerAuth.DeviceClaim, identity.Session.DeviceName ?? string.Empty),
        };
        if (identity.Viewer.MustChangePassword)
            claims.Add(new Claim(ViewerAuth.PasswordChangeClaim, "true"));
        if (fromCookie)
            claims.Add(new Claim(ViewerAuth.MethodClaim, "cookie"));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, ViewerAuth.Scheme, ClaimTypes.Name, ClaimTypes.Role));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, ViewerAuth.Scheme));
    }

    private string? BearerToken()
    {
        var header = Request.Headers.Authorization.ToString();
        const string scheme = "Bearer ";
        if (!header.StartsWith(scheme, StringComparison.Ordinal))
            return null;
        var token = header[scheme.Length..].Trim();
        return token.Length is > 0 and <= 512 ? token : null;
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.WWWAuthenticate = "Bearer";
        await Response.WriteAsJsonAsync(ErrorResponse.Of("unauthorized", "A valid viewer session is required. Admin sessions and API keys are not accepted here."));
    }

    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status403Forbidden;
        await Response.WriteAsJsonAsync(ErrorResponse.Of("forbidden", "This endpoint is only available to viewer accounts."));
    }
}
