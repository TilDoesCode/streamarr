using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/notifications")]
public sealed class NotificationConfigController(
    NotificationConfigService config,
    PushoverNotificationService notifications) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(NotificationConfigResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<NotificationConfigResponse>> Get(CancellationToken ct)
        => Ok(NotificationConfigResponse.From(await config.GetAsync(ct)));

    [HttpPut]
    [ProducesResponseType(typeof(NotificationConfigResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<NotificationConfigResponse>> Update(
        [FromBody] NotificationConfigWrite write,
        CancellationToken ct)
    {
        if (!Valid(write, out var error))
            return BadRequest(ErrorResponse.Of("invalid_notification_config", error));

        try
        {
            var saved = await config.UpdateAsync(write, ct);
            return Ok(NotificationConfigResponse.From(saved));
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(ErrorResponse.Of("invalid_notification_config", exception.Message));
        }
    }

    [HttpPost("test")]
    [ProducesResponseType(typeof(NotificationTestResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<NotificationTestResponse>> Test(CancellationToken ct)
    {
        try
        {
            await notifications.SendTestAsync(ct);
            return Ok(new NotificationTestResponse { Success = true, Message = "Test notification sent." });
        }
        catch (Exception exception) when (
            exception is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ErrorResponse.Of("pushover_failed", exception.Message));
        }
    }

    private static bool Valid(NotificationConfigWrite w, out string error)
    {
        error = string.Empty;
        if (w.AppToken?.Length > 128 || w.UserKey?.Length > 128 ||
            w.AppToken?.Any(char.IsControl) == true || w.UserKey?.Any(char.IsControl) == true ||
            w.Device?.Length > 25 || w.Sound?.Length > 64 ||
            w.Device?.Any(char.IsControl) == true || w.Sound?.Any(char.IsControl) == true)
            error = "Device and sound contain invalid characters or exceed their length limit.";
        else if (!ValidPriority(w.UsagePriority) || !ValidPriority(w.ErrorPriority) ||
                 !ValidPriority(w.OutagePriority) || !ValidPriority(w.RecoveryPriority))
            error = "Priorities must be between -2 and 2.";
        else if (w.ProgressIntervalMinutes is < 1 or > 1440)
            error = "Progress interval must be between 1 and 1440 minutes.";
        else if (w.ErrorCooldownSeconds is < 0 or > 86400)
            error = "Error cooldown must be between 0 and 86400 seconds.";
        else if (w.MonitorIntervalSeconds is < 15 or > 86400)
            error = "Monitor interval must be between 15 and 86400 seconds.";
        else if (w.OutageFailureThreshold is < 1 or > 100)
            error = "Outage failure threshold must be between 1 and 100.";
        else if (w.OutageReminderMinutes is < 0 or > 10080)
            error = "Outage reminder must be between 0 and 10080 minutes.";
        else if (w.EmergencyRetrySeconds is < 30 or > 10800)
            error = "Emergency retry must be between 30 and 10800 seconds.";
        else if (w.EmergencyExpireSeconds is < 30 or > 10800)
            error = "Emergency expiry must be between 30 and 10800 seconds.";
        return error.Length == 0;
    }

    private static bool ValidPriority(int value) => value is >= -2 and <= 2;
}
