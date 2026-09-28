using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Email;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Viewer sign-in, token refresh and sign-out. Separate from the admin <c>/api/v1/auth</c> endpoints.</summary>
[ApiController]
[Route("api/v1/viewer/auth")]
[RequiresModule(ViewerAuth.ModuleId)]
[ViewerProblemFilter]
public sealed class ViewerAuthController(
    ViewerSettingsService settings,
    ViewerLoginService logins,
    ViewerSessionService sessions,
    ViewerTwoFactorService twoFactor) : ControllerBase
{
    /// <summary>Which sign-in methods a viewer client should offer.</summary>
    [AllowAnonymous]
    [HttpGet("options")]
    [ProducesResponseType(typeof(ViewerAuthOptionsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<ViewerAuthOptionsResponse>> Options(CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        var mail = ViewerMailer.CanDeliver(current);
        return Ok(new ViewerAuthOptionsResponse
        {
            ServerName = current.ServerName,
            PasswordLogin = true,
            EmailCodeLogin = current.AllowEmailLogin && mail,
            PasswordReset = current.AllowPasswordReset && mail,
            TwoFactor = current.AllowTotp,
            PasswordMinLength = current.PasswordMinLength,
        });
    }

    /// <summary>Sign in with username (or verified email) and password; may answer with a second-factor challenge.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("login")]
    [ProducesResponseType(typeof(ViewerAuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status423Locked)]
    public async Task<ActionResult<ViewerAuthResponse>> Login([FromBody] ViewerLoginRequest request, CancellationToken ct)
    {
        var result = await logins.PasswordAsync(request.Login, request.Password, ct);
        return await CompleteAsync(result, request.DeviceName, request.ClientName, request.UseCookies, ct);
    }

    /// <summary>Finish a sign-in with an authenticator or recovery code.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("login/second-factor")]
    [ProducesResponseType(typeof(ViewerAuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<ViewerAuthResponse>> SecondFactor([FromBody] ViewerSecondFactorRequest request, CancellationToken ct)
    {
        var result = await logins.SecondFactorAsync(request.MfaToken, request.Code, ct);
        return await CompleteAsync(result, request.DeviceName, request.ClientName, request.UseCookies, ct);
    }

    /// <summary>Email a one-time sign-in code. Always 202 so the response does not reveal whether the account exists.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("email-code")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> RequestEmailCode([FromBody] ViewerCodeRequest request, CancellationToken ct)
    {
        await logins.RequestLoginCodeAsync(request.Login, ct);
        return Accepted();
    }

    /// <summary>Sign in with an emailed one-time code; may answer with a second-factor challenge.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("email-code/verify")]
    [ProducesResponseType(typeof(ViewerAuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<ViewerAuthResponse>> VerifyEmailCode([FromBody] ViewerCodeLoginRequest request, CancellationToken ct)
    {
        var result = await logins.LoginCodeAsync(request.Login, request.Code, ct);
        return await CompleteAsync(result, request.DeviceName, request.ClientName, request.UseCookies, ct);
    }

    /// <summary>Email a password-reset code. Always 202 so the response does not reveal whether the account exists.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("password/forgot")]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> ForgotPassword([FromBody] ViewerCodeRequest request, CancellationToken ct)
    {
        await logins.RequestPasswordResetAsync(request.Login, ct);
        return Accepted();
    }

    /// <summary>Set a new password with an emailed reset code; signs the viewer out everywhere.</summary>
    [AllowAnonymous]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("password/reset")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> ResetPassword([FromBody] ViewerPasswordResetRequest request, CancellationToken ct)
    {
        await logins.ResetPasswordAsync(request.Login, request.Code, request.NewPassword, ct);
        return NoContent();
    }

    /// <summary>Rotate the refresh token (body or cookie) and receive a fresh access token.</summary>
    [AllowAnonymous]
    [HttpPost("refresh")]
    [ProducesResponseType(typeof(ViewerSessionTokensResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<ViewerSessionTokensResponse>> Refresh([FromBody] ViewerRefreshRequest? request, CancellationToken ct)
    {
        var cookieMode = string.IsNullOrEmpty(request?.RefreshToken);
        var presented = cookieMode ? Request.Cookies[ViewerAuth.RefreshCookieName] : request!.RefreshToken;
        var (tokens, failure) = await sessions.RefreshAsync(presented, HttpContext.Connection.RemoteIpAddress?.ToString(), ct);
        if (tokens is null)
        {
            DeleteCookies();
            return Unauthorized(ErrorResponse.Of(
                failure == RefreshFailure.Reused ? "refresh_token_reused" : "refresh_session_expired",
                failure == RefreshFailure.Reused
                    ? "This refresh token was already used; the session was ended for safety."
                    : "The viewer session is missing or expired. Sign in again."));
        }
        return Ok(Tokens(tokens, cookieMode));
    }

    /// <summary>End the current viewer session (access token, refresh token, or cookies).</summary>
    [AllowAnonymous]
    [HttpPost("logout")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Logout([FromBody] ViewerRefreshRequest? request, CancellationToken ct)
    {
        var auth = await HttpContext.AuthenticateAsync(ViewerAuth.Scheme);
        if (auth.Succeeded && auth.Principal is { } principal)
            await sessions.RevokeAsync(principal.ViewerId(), principal.SessionId(), "logout", ct);
        await sessions.RevokeByRefreshTokenAsync(request?.RefreshToken ?? Request.Cookies[ViewerAuth.RefreshCookieName], ct);
        DeleteCookies();
        return NoContent();
    }

    private async Task<ActionResult<ViewerAuthResponse>> CompleteAsync(
        ViewerLoginResult result, string? deviceName, string? clientName, bool useCookies, CancellationToken ct)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (result.Viewer is not { } viewer)
            return Ok(new ViewerAuthResponse { Status = "mfa_required", MfaToken = result.MfaToken, MfaExpiresAt = result.MfaExpiresAt });

        var tokens = await sessions.IssueAsync(viewer, new ViewerSessionRequest(
            deviceName ?? string.Empty,
            clientName ?? Request.Headers.UserAgent.ToString(),
            result.Method,
            useCookies,
            HttpContext.Connection.RemoteIpAddress?.ToString()), ct);
        return Ok(new ViewerAuthResponse
        {
            Status = "authenticated",
            Session = Tokens(tokens, useCookies),
            Viewer = ViewerMappings.Profile(viewer, await twoFactor.RemainingRecoveryCodesAsync(viewer.Id, ct)),
        });
    }

    private ViewerSessionTokensResponse Tokens(ViewerTokens tokens, bool cookieMode)
    {
        if (cookieMode)
        {
            Response.Cookies.Append(ViewerAuth.CookieName, tokens.AccessToken, ViewerAuth.AccessCookie(Request.IsHttps, tokens.AccessExpiresAt));
            Response.Cookies.Append(ViewerAuth.RefreshCookieName, tokens.RefreshToken, ViewerAuth.RefreshCookie(Request.IsHttps, tokens.RefreshExpiresAt));
        }
        return new ViewerSessionTokensResponse
        {
            SessionId = tokens.SessionId,
            AccessToken = cookieMode ? null : tokens.AccessToken,
            AccessExpiresAt = tokens.AccessExpiresAt,
            RefreshToken = cookieMode ? null : tokens.RefreshToken,
            RefreshExpiresAt = tokens.RefreshExpiresAt,
            CookieMode = cookieMode,
        };
    }

    private void DeleteCookies()
    {
        Response.Cookies.Delete(ViewerAuth.CookieName, ViewerAuth.AccessCookie(Request.IsHttps));
        Response.Cookies.Delete(ViewerAuth.RefreshCookieName, ViewerAuth.RefreshCookie(Request.IsHttps));
    }
}
