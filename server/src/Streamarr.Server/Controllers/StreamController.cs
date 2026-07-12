using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/stream/{token} — a plain, authenticated, Range-capable HTTP byte
/// stream (BRIEF §3.3): honors <c>Range: bytes=…</c> with 206 + Content-Range +
/// Accept-Ranges, serves the full body otherwise, and seeks anywhere — including
/// inside RAR-wrapped files. Player-agnostic by contract; no Jellyfin-specific
/// behavior may ever be added here.
/// </summary>
[ApiController]
public class StreamController(SessionManager sessionManager) : ControllerBase
{
    [HttpGet("api/v1/stream/{token}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status206PartialContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult GetStream(string token)
    {
        if (!sessionManager.TryGetSession(token, out var session))
        {
            return NotFound(ErrorResponse.Of(
                "unknown_stream", "No live session exists for this token (closed or expired)."));
        }

        var stream = sessionManager.OpenStream(session);
        return File(stream, session.ContentType, enableRangeProcessing: true);
    }
}
