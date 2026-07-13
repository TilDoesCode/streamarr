using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
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
    IOptions<StreamarrOpts> options) : ControllerBase
{
    /// <summary>Exchange admin credentials for a short-lived session token.</summary>
    [AllowAnonymous]
    [HttpPost("login")]
    [ProducesResponseType(typeof(LoginResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<LoginResponse>> Login([FromBody] LoginRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrEmpty(request.Password))
            return BadRequest(ErrorResponse.Of("invalid_login", "'username' and 'password' are required."));

        var user = await users.AuthenticateAsync(request.Username.Trim(), request.Password, ct);
        if (user is null)
            return Unauthorized(ErrorResponse.Of("invalid_credentials", "Incorrect username or password."));

        var (token, expiresAt) = jwt.CreateToken(user);
        return Ok(new LoginResponse
        {
            Token = token,
            ExpiresInSeconds = Math.Max(60, options.Value.AdminSessionTtlSeconds),
            ExpiresAt = expiresAt,
            Username = user.Username,
            Role = user.Role,
        });
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
        if (request is null || string.IsNullOrEmpty(request.NewPassword) || request.NewPassword.Length < 8)
            return BadRequest(ErrorResponse.Of("invalid_password", "'newPassword' must be at least 8 characters."));

        var username = User.Identity?.Name;
        if (string.IsNullOrEmpty(username))
            return Unauthorized(ErrorResponse.Of("unauthorized", "No admin session."));

        var user = await users.AuthenticateAsync(username, request.CurrentPassword ?? string.Empty, ct);
        if (user is null)
            return BadRequest(ErrorResponse.Of("invalid_credentials", "The current password is incorrect."));

        await users.ChangePasswordAsync(user.Id, request.NewPassword, ct);
        return NoContent();
    }
}
