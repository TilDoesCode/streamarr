using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>The signed-in viewer's own account: profile, password, email, two-factor and devices.</summary>
[ApiController]
[Route("api/v1/viewer/me")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
public sealed class ViewerMeController(
    ViewerAccountService accounts,
    ViewerTwoFactorService twoFactor,
    ViewerSessionService sessions) : ControllerBase
{
    [AllowPendingPasswordChange]
    [HttpGet]
    [ProducesResponseType(typeof(ViewerProfileResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<ViewerProfileResponse>> Get(CancellationToken ct)
        => Ok(await ProfileAsync(await accounts.GetAsync(User.ViewerId(), ct), ct));

    [HttpPatch]
    [ProducesResponseType(typeof(ViewerProfileResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerProfileResponse>> Update([FromBody] ViewerProfileUpdateRequest request, CancellationToken ct)
        => Ok(await ProfileAsync(await accounts.UpdateDisplayNameAsync(User.ViewerId(), request.DisplayName, ct), ct));

    /// <summary>Change the password; every other device is signed out.</summary>
    [AllowPendingPasswordChange]
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("password")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> ChangePassword([FromBody] ViewerChangePasswordRequest request, CancellationToken ct)
    {
        await accounts.ChangePasswordAsync(User.ViewerId(), request.CurrentPassword, request.NewPassword, User.SessionId(), ct);
        return NoContent();
    }

    /// <summary>Set, change or remove the email address; a new address is confirmed with an emailed code.</summary>
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("email")]
    [ProducesResponseType(typeof(ViewerEmailChangeResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ViewerEmailChangeResponse>> ChangeEmail([FromBody] ViewerEmailChangeRequest request, CancellationToken ct)
    {
        var sent = await accounts.RequestEmailChangeAsync(User.ViewerId(), request.Email, request.CurrentPassword, ct);
        return Ok(new ViewerEmailChangeResponse { VerificationSent = sent, PendingEmail = sent ? request.Email?.Trim() : null });
    }

    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("email/verify")]
    [ProducesResponseType(typeof(ViewerProfileResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerProfileResponse>> VerifyEmail([FromBody] ViewerCodeConfirmRequest request, CancellationToken ct)
        => Ok(await ProfileAsync(await accounts.ConfirmEmailAsync(User.ViewerId(), request.Code, ct), ct));

    /// <summary>Start authenticator-app enrolment; returns the secret and an otpauth:// URI for a QR code.</summary>
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("two-factor/setup")]
    [ProducesResponseType(typeof(ViewerTotpSetupResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerTotpSetupResponse>> SetupTwoFactor([FromBody] ViewerPasswordConfirmRequest request, CancellationToken ct)
    {
        var setup = await twoFactor.BeginSetupAsync(User.ViewerId(), request.CurrentPassword, ct);
        return Ok(new ViewerTotpSetupResponse
        {
            Secret = setup.Secret,
            OtpAuthUri = setup.OtpAuthUri,
            Issuer = setup.Issuer,
            AccountName = setup.AccountName,
        });
    }

    /// <summary>Confirm enrolment with a first code; returns the one-time recovery codes.</summary>
    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("two-factor/enable")]
    [ProducesResponseType(typeof(ViewerRecoveryCodesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerRecoveryCodesResponse>> EnableTwoFactor([FromBody] ViewerCodeConfirmRequest request, CancellationToken ct)
        => Ok(new ViewerRecoveryCodesResponse { RecoveryCodes = await twoFactor.EnableAsync(User.ViewerId(), request.Code, ct) });

    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("two-factor/disable")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> DisableTwoFactor([FromBody] ViewerPasswordConfirmRequest request, CancellationToken ct)
    {
        await twoFactor.DisableAsync(User.ViewerId(), request.CurrentPassword, ct);
        return NoContent();
    }

    [EnableRateLimiting(ViewerAuth.RateLimitPolicy)]
    [HttpPost("two-factor/recovery-codes")]
    [ProducesResponseType(typeof(ViewerRecoveryCodesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerRecoveryCodesResponse>> RegenerateRecoveryCodes([FromBody] ViewerPasswordConfirmRequest request, CancellationToken ct)
        => Ok(new ViewerRecoveryCodesResponse { RecoveryCodes = await twoFactor.RegenerateRecoveryCodesAsync(User.ViewerId(), request.CurrentPassword, ct) });

    [AllowPendingPasswordChange]
    [HttpGet("sessions")]
    [ProducesResponseType(typeof(IReadOnlyList<ViewerDeviceSessionResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ViewerDeviceSessionResponse>>> Sessions(CancellationToken ct)
    {
        var current = User.SessionId();
        return Ok((await sessions.ListActiveAsync(User.ViewerId(), ct)).Select(s => ViewerMappings.Device(s, current)).ToList());
    }

    [AllowPendingPasswordChange]
    [HttpDelete("sessions/{sessionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> RevokeSession(string sessionId, CancellationToken ct)
        => await sessions.RevokeAsync(User.ViewerId(), sessionId, "revoked_by_viewer", ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("session_not_found", "No active session with this id."));

    private async Task<ViewerProfileResponse> ProfileAsync(Persistence.Entities.ViewerEntity viewer, CancellationToken ct)
        => ViewerMappings.Profile(viewer, await twoFactor.RemainingRecoveryCodesAsync(viewer.Id, ct));
}
