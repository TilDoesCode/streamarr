using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>GET /api/v1/sessions + POST /api/v1/sessions/{token}/close (BRIEF §6.2).</summary>
[ApiController]
[Route("api/v1/sessions")]
public class SessionsController(SessionManager sessionManager) : ControllerBase
{
    [HttpGet]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<SessionResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<SessionResponse>> List()
        => Ok(sessionManager.ListSessions().Select(ToResponse).ToList());

    [HttpPost("{token}/close")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult Close(string token)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        return sessionManager.CloseSession(token)
            ? NoContent()
            : NotFound(ErrorResponse.Of("unknown_session", "No live session exists for this token."));
    }

    private static SessionResponse ToResponse(ActiveSession active) => new()
    {
        Token = active.Token,
        ReleaseId = active.Session.ReleaseId,
        WorkId = active.Session.WorkId,
        State = active.Session.State.ToString().ToLowerInvariant(),
        Container = active.Session.Container,
        SizeBytes = active.Session.SizeBytes,
        BytesServed = active.BytesServed,
        NntpConnectionsInFlight = active.NntpUsage.InFlight,
        NntpCommandsTotal = active.NntpUsage.TotalCommands,
        Client = active.Session.Client,
        CreatedAt = active.Session.CreatedAt,
        LastAccessedAt = active.Session.LastAccessedAt,
        ExpiresAt = active.ExpiresAt,
    };
}
