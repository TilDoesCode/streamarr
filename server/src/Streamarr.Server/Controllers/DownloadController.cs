using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/download/{token} — the same capability-authorized session as
/// GET /api/v1/stream/{token} (<see cref="StreamController"/>), served at full transport
/// speed instead of paced for real-time playback, with an attachment
/// <c>Content-Disposition</c> so any HTTP client saves the complete file. Callers that want
/// the whole file as fast as the configured Usenet provider(s) allow — rather than paced to
/// match playback — use this sibling instead of <c>/stream</c>. Player-agnostic by contract;
/// no Jellyfin-specific behavior may ever be added here (mirrors <see cref="StreamController"/>).
/// </summary>
[ApiController]
public class DownloadController(SessionManager sessionManager) : ControllerBase
{
    [HttpGet("api/v1/download/{token}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status206PartialContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult GetDownload(string token)
    {
        SetCapabilityResponseHeaders();

        if (!sessionManager.TryGetSession(token, out var session))
        {
            return NotFound(ErrorResponse.Of(
                "unknown_stream", "No live session exists for this token (closed or expired)."));
        }

        try
        {
            var stream = sessionManager.OpenStream(session, paced: false);
            return File(stream, session.ContentType, session.File.FileName, enableRangeProcessing: true);
        }
        catch (ResourceCapacityException)
        {
            Response.Headers.RetryAfter = "1";
            return StatusCode(StatusCodes.Status429TooManyRequests, ErrorResponse.Of(
                "stream_capacity", "The stream concurrency limit is currently reached; retry shortly."));
        }
        catch (SessionUnavailableException)
        {
            return NotFound(ErrorResponse.Of(
                "unknown_stream", "The live session closed or expired before the stream could be opened."));
        }
    }

    private void SetCapabilityResponseHeaders()
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Headers.Pragma = "no-cache";
        Response.Headers.Expires = "0";
        Response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
