using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using StreamarrOpts = Streamarr.Server.Options.StreamarrOptions;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Admin session auth (BRIEF §6.4): username/password login issuing a short-lived JWT that
/// unlocks everything including /config and /debug, the caller's identity, and admin
/// password change. Login itself is anonymous; the rest require a valid session.
/// </summary>
[ApiController]
[Route("api/v1/auth")]
public class AuthController(
    UserService users,
    JwtTokenService jwt,
    AdminRefreshSessionService refreshSessions,
    IOptions<StreamarrOpts> options) : ControllerBase
{
    /// <summary>Exchange admin credentials for a short-lived session token.</summary>
    [AllowAnonymous]
    [EnableRateLimiting("login")]
    [HttpPost("login")]
    [ProducesResponseType(typeof(LoginResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<LoginResponse>> Login([FromBody] LoginRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrEmpty(request.Password) ||
            request.Username.Length > 128 || request.Password.Length > 1024)
            return BadRequest(ErrorResponse.Of("invalid_login", "'username' and 'password' are required."));

        var user = await users.AuthenticateAsync(request.Username.Trim(), request.Password, ct);
        if (user is null)
            return Unauthorized(ErrorResponse.Of("invalid_credentials", "Incorrect username or password."));

        var refreshSession = await refreshSessions.IssueAsync(user, ct);
        var (token, expiresAt) = jwt.CreateToken(user);
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Cookies.Append(AdminAuthCookie.Name, token, AdminAuthCookie.Options(Request.IsHttps, expiresAt));
        Response.Cookies.Append(
            AdminAuthCookie.RefreshName,
            refreshSession.Token,
            AdminAuthCookie.RefreshOptions(Request.IsHttps, refreshSession.ExpiresAt));
        return Ok(SessionResponse(user.Username, user.Role, token, expiresAt, refreshSession.ExpiresAt));
    }

    /// <summary>Rotate the browser refresh token and issue a fresh access session.</summary>
    [AllowAnonymous]
    [HttpPost("refresh")]
    [ProducesResponseType(typeof(LoginResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<LoginResponse>> Refresh(CancellationToken ct)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (!Request.Cookies.TryGetValue(AdminAuthCookie.RefreshName, out var refreshToken))
        {
            DeleteSessionCookies();
            return Unauthorized(ErrorResponse.Of("refresh_session_expired", "The refresh session is missing or expired."));
        }

        var refreshSession = await refreshSessions.RotateAsync(refreshToken, ct);
        if (refreshSession is null)
        {
            DeleteSessionCookies();
            return Unauthorized(ErrorResponse.Of("refresh_session_expired", "The refresh session is missing or expired."));
        }

        var (token, expiresAt) = jwt.CreateToken(refreshSession.User);
        Response.Cookies.Append(AdminAuthCookie.Name, token, AdminAuthCookie.Options(Request.IsHttps, expiresAt));
        Response.Cookies.Append(
            AdminAuthCookie.RefreshName,
            refreshSession.Token,
            AdminAuthCookie.RefreshOptions(Request.IsHttps, refreshSession.ExpiresAt));
        return Ok(SessionResponse(
            refreshSession.User.Username,
            refreshSession.User.Role,
            token,
            expiresAt,
            refreshSession.ExpiresAt));
    }

    /// <summary>Revoke and expire the browser admin session.</summary>
    [AllowAnonymous]
    [HttpPost("logout")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Request.Cookies.TryGetValue(AdminAuthCookie.RefreshName, out var refreshToken);
        var revokedRefreshSession = await refreshSessions.RevokeAsync(refreshToken, ct);
        if (revokedRefreshSession || User.IsInRole(AuthRoles.Admin))
            jwt.RevokeAll();
        DeleteSessionCookies();
        return NoContent();
    }

    /// <summary>The identity behind the presented bearer token (machine or admin).</summary>
    [Authorize]
    [HttpGet("me")]
    [ProducesResponseType(typeof(MeResponse), StatusCodes.Status200OK)]
    public ActionResult<MeResponse> Me()
        => Ok(new MeResponse
        {
            Name = User.Identity?.Name ?? "unknown",
            Role = User.FindFirstValue(ClaimTypes.Role) ?? "unknown",
        });

    /// <summary>Change the signed-in admin's password.</summary>
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [HttpPost("password")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> ChangePassword([FromBody] ChangePasswordRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrEmpty(request.NewPassword) || request.NewPassword.Length is < 12 or > 1024)
            return BadRequest(ErrorResponse.Of("invalid_password", "'newPassword' must be between 12 and 1024 characters."));

        var username = User.Identity?.Name;
        if (string.IsNullOrEmpty(username))
            return Unauthorized(ErrorResponse.Of("unauthorized", "No admin session."));

        var user = await users.AuthenticateAsync(username, request.CurrentPassword ?? string.Empty, ct);
        if (user is null)
            return BadRequest(ErrorResponse.Of("invalid_credentials", "The current password is incorrect."));

        await users.ChangePasswordAsync(user.Id, request.NewPassword, ct);
        await refreshSessions.RevokeAllForUserAsync(user.Id, ct);
        jwt.RevokeAll();
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        DeleteSessionCookies();
        return NoContent();
    }

    private LoginResponse SessionResponse(
        string username,
        string role,
        string token,
        DateTimeOffset expiresAt,
        DateTimeOffset refreshExpiresAt)
        => new()
        {
            Token = token,
            ExpiresInSeconds = Math.Max(60, options.Value.AdminSessionTtlSeconds),
            ExpiresAt = expiresAt,
            RefreshExpiresAt = refreshExpiresAt,
            Username = username,
            Role = role,
        };

    private void DeleteSessionCookies()
    {
        Response.Cookies.Delete(AdminAuthCookie.Name, AdminAuthCookie.Options(Request.IsHttps));
        Response.Cookies.Delete(AdminAuthCookie.RefreshName, AdminAuthCookie.RefreshOptions(Request.IsHttps));
    }
}
