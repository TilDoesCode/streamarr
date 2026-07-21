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

    /// <summary>
    /// Appends client-observed spans (Jellyfin's PlaybackInfo→first delivered frame) to a live
    /// session's request→first-frame timeline so the stream page flamegraph spans both processes.
    /// The capability token is the authorization (same model as the anonymous close), so this
    /// stays player-agnostic and needs no machine credential in the player.
    /// </summary>
    [HttpPost("{token}/timeline")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult AppendTimeline(string token, [FromBody] ClientTimelineRequest request)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (!sessionManager.TryGetSession(token, out var session) || session.Timeline is null)
            return NotFound(ErrorResponse.Of("unknown_session", "No live session exists for this token."));

        foreach (var span in (request?.Spans ?? []).Take(TtffTimeline.MaxSpans))
        {
            session.Timeline.Add(
                span.Name,
                string.IsNullOrWhiteSpace(span.Category) ? "client" : span.Category!,
                span.StartMs,
                span.DurationMs,
                span.Detail,
                source: "client");
        }

        return NoContent();
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
        RequestedById = active.Session.RequestedById,
        RequestedByName = active.Session.RequestedByName,
        CreatedAt = active.Session.CreatedAt,
        LastAccessedAt = active.Session.LastAccessedAt,
        ExpiresAt = active.ExpiresAt,
        TimelineStartedAt = active.Timeline?.StartedAt,
        Timeline = active.Timeline is null
            ? []
            : active.Timeline.Snapshot().Select(s => new TtffSpanResponse
            {
                Name = s.Name,
                Category = s.Category,
                StartMs = s.StartMs,
                DurationMs = s.DurationMs,
                Detail = s.Detail,
                Source = s.Source,
            }).ToList(),
    };
}
