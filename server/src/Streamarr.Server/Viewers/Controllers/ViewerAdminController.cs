using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Security;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Email;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Admin management of viewer (watch) accounts and the viewer module. Viewers never reach these endpoints.</summary>
[ApiController]
[Route("api/v1/config/viewers")]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[ViewerProblemFilter]
public sealed class ViewerAdminController(
    ViewerSettingsService settings,
    ViewerAccountService accounts,
    ViewerSessionService sessions,
    ViewerTwoFactorService twoFactor,
    WatchStateService watch,
    ViewerMailer mailer,
    ViewerMailOutbox outbox,
    ViewerMailLanguage mailLanguage,
    TimeProvider time) : ControllerBase
{
    [HttpGet("settings")]
    [ProducesResponseType(typeof(ViewerSettingsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<ViewerSettingsResponse>> GetSettings(CancellationToken ct)
        => Ok(await SettingsResponseAsync(await settings.GetAsync(ct), ct));

    /// <summary>Partial update; switching <c>enabled</c> off makes every viewer endpoint answer 404 <c>module_disabled</c>.</summary>
    [HttpPut("settings")]
    [ProducesResponseType(typeof(ViewerSettingsResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ViewerSettingsResponse>> UpdateSettings([FromBody] ViewerSettingsWrite write, CancellationToken ct)
    {
        var next = ViewerMappings.Apply(await settings.GetAsync(ct), write);
        if (next.Validate() is { Count: > 0 } errors)
            return BadRequest(ErrorResponse.Of("invalid_viewer_settings", string.Join(" ", errors)));
        var password = write.Email?.SmtpPassword;
        if (password is { Length: > 1024 })
            return BadRequest(ErrorResponse.Of("invalid_viewer_settings", "'email.smtpPassword' is too long."));
        var saved = await settings.SaveAsync(next, password == SecretMasking.Mask ? null : password, ct);
        return Ok(await SettingsResponseAsync(saved, ct));
    }

    /// <summary>Sends a test message synchronously and reports transport errors.</summary>
    [HttpPost("settings/test-email")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> TestEmail([FromBody] ViewerTestEmailRequest request, CancellationToken ct)
    {
        var to = request.To?.Trim();
        if (!ViewerEmail.IsValid(to))
            return BadRequest(ErrorResponse.Of("invalid_email", "'to' must be a valid email address."));
        try
        {
            await mailer.SendNowAsync(ViewerMailTemplates.Test(mailLanguage.Current, (await settings.GetAsync(ct)).ServerName, to!), ct);
        }
        catch (Exception e) when (e is not ViewerProblem and not OperationCanceledException)
        {
            return StatusCode(StatusCodes.Status502BadGateway, ErrorResponse.Of("email_delivery_failed", $"{e.GetType().Name}: {e.Message}"));
        }
        return NoContent();
    }

    /// <summary>Messages captured while email delivery runs in test-outbox mode (newest first).</summary>
    [HttpGet("outbox")]
    [ProducesResponseType(typeof(IReadOnlyList<ViewerOutboxMessageResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<ViewerOutboxMessageResponse>> Outbox()
        => Ok(outbox.List().Select(m => new ViewerOutboxMessageResponse
        {
            Id = m.Id,
            CreatedAt = m.CreatedAt,
            To = m.Message.To,
            Subject = m.Message.Subject,
            Kind = m.Message.Kind,
            Text = m.Message.Text,
        }).ToList());

    [HttpDelete("outbox")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult ClearOutbox()
    {
        outbox.Clear();
        return NoContent();
    }

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ViewerAdminResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ViewerAdminResponse>>> List(CancellationToken ct)
    {
        var counts = await sessions.CountActiveAsync(ct);
        var summaries = await watch.SummariesAsync(ct);
        var now = time.GetUtcNow();
        return Ok((await accounts.ListAsync(ct)).Select(v => ViewerMappings.Admin(
            v, counts.GetValueOrDefault(v.Id), summaries.GetValueOrDefault(v.Id), now)).ToList());
    }

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(ViewerAdminResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ViewerAdminResponse>> Get(string id, CancellationToken ct)
        => Ok(await AdminAsync(await accounts.GetAsync(id, ct), ct));

    /// <summary>Create a viewer; an omitted password is generated and returned exactly once.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(ViewerCreatedResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ViewerCreatedResponse>> Create([FromBody] ViewerCreateRequest request, CancellationToken ct)
    {
        var (viewer, generated) = await accounts.CreateAsync(new ViewerCreate(
            request.Username ?? string.Empty,
            request.DisplayName,
            request.Email,
            request.Password,
            request.MustChangePassword,
            ViewerMappings.Permissions(request.Permissions),
            request.Disabled), ct);
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        return CreatedAtAction(nameof(Get), new { id = viewer.Id }, new ViewerCreatedResponse
        {
            Viewer = await AdminAsync(viewer, ct),
            GeneratedPassword = generated,
        });
    }

    [HttpPatch("{id}")]
    [ProducesResponseType(typeof(ViewerAdminResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<ViewerAdminResponse>> Update(string id, [FromBody] ViewerUpdateRequest request, CancellationToken ct)
    {
        var permissions = request.Permissions;
        var viewer = await accounts.UpdateAsync(id, new ViewerUpdate
        {
            DisplayName = request.DisplayName,
            Email = string.IsNullOrWhiteSpace(request.Email) ? null : request.Email,
            ClearEmail = request.Email is { } email && string.IsNullOrWhiteSpace(email),
            Disabled = request.Disabled,
            MustChangePassword = request.MustChangePassword,
            Unlock = request.Unlock,
            MaxAge = permissions?.MaxAge,
            ClearMaxAge = permissions is { MaxAge: null },
            BlockUnrated = permissions?.BlockUnrated,
            AllowTranscoding = permissions?.AllowTranscoding,
            MaxConcurrentStreams = permissions?.MaxConcurrentStreams,
            ClearMaxConcurrentStreams = permissions is { MaxConcurrentStreams: null },
        }, ct);
        return Ok(await AdminAsync(viewer, ct));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        await accounts.DeleteAsync(id, ct);
        return NoContent();
    }

    /// <summary>Assign a password (or generate one); signs the viewer out everywhere.</summary>
    [HttpPost("{id}/password")]
    [ProducesResponseType(typeof(ViewerSetPasswordResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ViewerSetPasswordResponse>> SetPassword(string id, [FromBody] ViewerSetPasswordRequest request, CancellationToken ct)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        return Ok(new ViewerSetPasswordResponse
        {
            GeneratedPassword = await accounts.SetPasswordAsync(id, request.Password, request.MustChangePassword, ct),
        });
    }

    /// <summary>Remove a lost authenticator and its recovery codes.</summary>
    [HttpPost("{id}/two-factor/reset")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ResetTwoFactor(string id, CancellationToken ct)
    {
        await twoFactor.ResetAsync(id, ct);
        return NoContent();
    }

    [HttpGet("{id}/sessions")]
    [ProducesResponseType(typeof(IReadOnlyList<ViewerDeviceSessionResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ViewerDeviceSessionResponse>>> Sessions(string id, CancellationToken ct)
    {
        await accounts.GetAsync(id, ct);
        return Ok((await sessions.ListActiveAsync(id, ct)).Select(s => ViewerMappings.Device(s, null)).ToList());
    }

    [HttpDelete("{id}/sessions")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> RevokeSessions(string id, CancellationToken ct)
    {
        await sessions.RevokeAllAsync(id, "revoked_by_admin", exceptSessionId: null, ct);
        return NoContent();
    }

    [HttpDelete("{id}/sessions/{sessionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> RevokeSession(string id, string sessionId, CancellationToken ct)
        => await sessions.RevokeAsync(id, sessionId, "revoked_by_admin", ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("session_not_found", "No active session with this id."));

    [HttpGet("{id}/watch-state")]
    [ProducesResponseType(typeof(WatchHistoryResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchHistoryResponse>> WatchState(string id, [FromQuery] int limit = 50, [FromQuery] int offset = 0, CancellationToken ct = default)
    {
        await accounts.GetAsync(id, ct);
        var (items, total) = await watch.HistoryAsync(id, limit, offset, ct);
        return Ok(new WatchHistoryResponse { Items = items.Select(ViewerMappings.State).ToList(), Total = total });
    }

    [HttpDelete("{id}/watch-state")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> ClearWatchState(string id, CancellationToken ct)
    {
        await watch.ClearAsync(id, ct);
        return NoContent();
    }

    private async Task<ViewerAdminResponse> AdminAsync(Persistence.Entities.ViewerEntity viewer, CancellationToken ct)
    {
        var count = (await sessions.ListActiveAsync(viewer.Id, ct)).Count;
        var summary = (await watch.SummariesAsync(ct)).GetValueOrDefault(viewer.Id);
        return ViewerMappings.Admin(viewer, count, summary, time.GetUtcNow());
    }

    private async Task<ViewerSettingsResponse> SettingsResponseAsync(ViewerSettings current, CancellationToken ct)
        => ViewerMappings.Settings(current, await settings.HasSmtpPasswordAsync(ct), (await accounts.ListAsync(ct)).Count);
}
