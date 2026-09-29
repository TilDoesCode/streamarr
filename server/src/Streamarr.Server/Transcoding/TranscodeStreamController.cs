using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Transcoding;

/// <summary>
/// Capability-authorized HLS rendition of a transcode session. Like <c>/api/v1/stream</c>, the unguessable path token is the
/// only credential, so plain players (hls.js, Safari, TVs) can fetch playlists and segments without auth headers.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/v1/transcode/{token}")]
public sealed class TranscodeStreamController(TranscodeSessionManager sessions) : ControllerBase
{
    private const string PlaylistType = "application/vnd.apple.mpegurl";

    [HttpGet("master.m3u8")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult Master(string token)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        session.Touch();
        return Content(HlsPlaylist.Master(session.Plan), PlaylistType);
    }

    [HttpGet("main.m3u8")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult Media(string token)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        session.Touch();
        return Content(HlsPlaylist.Media(session.Timeline), PlaylistType);
    }

    [HttpGet("init.mp4")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public async Task<IActionResult> Init(string token, CancellationToken ct)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        try
        {
            return File(await sessions.GetInitAsync(session, ct), "video/mp4");
        }
        catch (TranscodeException e)
        {
            return Failure(e);
        }
    }

    [HttpGet("{segment:int:min(0)}.m4s")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public async Task<IActionResult> Segment(string token, int segment, CancellationToken ct)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        try
        {
            var path = await sessions.GetSegmentAsync(session, segment, ct);
            FileStream stream;
            try
            {
                stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
            }
            catch (FileNotFoundException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable,
                    ErrorResponse.Of("segment_evicted", "The segment was replaced while opening; retry."));
            }
            session.NoteServed(stream.Length);
            return File(stream, "video/mp4");
        }
        catch (TranscodeException e)
        {
            return Failure(e);
        }
    }

    [HttpGet("subtitles/{stream:int:min(0)}/main.m3u8")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult SubtitlePlaylist(string token, int stream)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        if (session.Subtitles.All(s => s.StreamIndex != stream))
            return NotFound(ErrorResponse.Of("unknown_subtitle_stream", "This session has no such subtitle rendition."));
        session.Touch();
        return Content(HlsPlaylist.Subtitles(session.Timeline), PlaylistType);
    }

    /// <summary>WebVTT segment aligned with the video segment of the same index; cue times are on the media timeline.</summary>
    [HttpGet("subtitles/{stream:int:min(0)}/{segment:int:min(0)}.vtt")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public async Task<IActionResult> SubtitleSegment(string token, int stream, int segment, CancellationToken ct)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        try
        {
            return Content(await sessions.GetSubtitleSegmentAsync(session, stream, segment, ct), WebVttSubtitles.ContentType);
        }
        catch (TranscodeException e)
        {
            return Failure(e);
        }
    }

    /// <summary>Ends the session and its ffmpeg run; any holder of the playlist capability may stop it.</summary>
    [HttpDelete]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Stop(string token)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        await sessions.CloseAsync(session, "stopped by the player");
        return NoContent();
    }

    private IActionResult Failure(TranscodeException e)
    {
        if (e.StatusCode is 503 or 504)
            Response.Headers.RetryAfter = "1";
        return StatusCode(e.StatusCode, ErrorResponse.Of(e.Code, e.Message));
    }

    private NotFoundObjectResult Unknown()
        => NotFound(ErrorResponse.Of("unknown_transcode", "No transcode session exists for this token (stopped or expired)."));

    private void NoStore()
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        Response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
