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
[ServiceFilter(typeof(HlsDeliveryIssueFilter))]
public sealed class TranscodeStreamController(TranscodeSessionManager sessions, HlsDeliveryIssues issues, ILogger<TranscodeStreamController> logger) : ControllerBase
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
        return Content(HlsPlaylist.Master(session.Plan, PlayerQuery(session.NextPlayerTag())), PlaylistType);
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
        return Content(HlsPlaylist.Media(session.Timeline, PlayerQuery()), PlaylistType);
    }

    [HttpGet("init.mp4")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public Task<IActionResult> Init(string token, CancellationToken ct) => ServeInit(token, null, ct);

    [HttpGet("{segment:int:min(0)}.m4s")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public Task<IActionResult> Segment(string token, int segment, CancellationToken ct) => ServeSegment(token, null, segment, ct);

    /// <summary>Audio rendition playlist of a demuxed session: same timeline and segment boundaries as the video.</summary>
    [HttpGet("audio/{rendition}/main.m3u8")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult AudioPlaylist(string token, string rendition)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        if (session.Plan.AudioRenditions.All(r => r.Id != rendition))
            return UnknownRendition();
        session.Touch();
        return Content(HlsPlaylist.Media(session.Timeline, PlayerQuery()), PlaylistType);
    }

    [HttpGet("audio/{rendition}/init.mp4")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public Task<IActionResult> AudioInit(string token, string rendition, CancellationToken ct) => ServeInit(token, rendition, ct);

    [HttpGet("audio/{rendition}/{segment:int:min(0)}.m4s")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status500InternalServerError)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status504GatewayTimeout)]
    public Task<IActionResult> AudioSegment(string token, string rendition, int segment, CancellationToken ct)
        => ServeSegment(token, rendition, segment, ct);

    private async Task<IActionResult> ServeInit(string token, string? rendition, CancellationToken ct)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        if (!TryTrack(session, rendition, out var track))
            return UnknownRendition();
        try
        {
            var init = await sessions.GetInitAsync(session, ct);
            return File(track is { } id ? Fmp4TrackSplit.Init(init, id) : init, "video/mp4");
        }
        catch (TranscodeException e)
        {
            return Failure(e);
        }
        catch (InvalidDataException e)
        {
            return SplitFailure(e, rendition, null);
        }
    }

    private async Task<IActionResult> ServeSegment(string token, string? rendition, int segment, CancellationToken ct)
    {
        NoStore();
        if (!sessions.TryGet(token, out var session))
            return Unknown();
        if (!TryTrack(session, rendition, out var track))
            return UnknownRendition();
        try
        {
            var path = await sessions.GetSegmentAsync(session, segment, ct, Requester());
            FileStream stream;
            try
            {
                stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
            }
            catch (FileNotFoundException)
            {
                return SegmentEvicted(Response);
            }
            if (track is not { } id)
            {
                session.NoteServed(stream.Length);
                return File(stream, "video/mp4");
            }
            await using (stream)
            {
                var parts = await Fmp4TrackSplit.PlanAsync(stream, id, ct);
                var length = parts.Sum(p => p.Size);
                session.NoteServed(length);
                Response.StatusCode = StatusCodes.Status200OK;
                Response.ContentType = "video/mp4";
                Response.ContentLength = length;
                await Fmp4TrackSplit.CopyAsync(stream, parts, Response.Body, ct);
            }
            return new EmptyResult();
        }
        catch (TranscodeException e)
        {
            return Failure(e);
        }
        catch (Exception e) when (e is InvalidDataException or EndOfStreamException)
        {
            if (Response.HasStarted)
            {
                logger.LogWarning(e, "Audio rendition {Rendition} segment {Segment} broke off while streaming", rendition, segment);
                issues.Report(Request.Path, StatusCodes.Status500InternalServerError, "rendition_split_failed");
                HttpContext.Abort();
                return new EmptyResult();
            }
            return SplitFailure(e, rendition, segment);
        }
    }

    /// <summary>The segment file vanished between the wait and the open (retention or a restart); a quick retry finds the new one.</summary>
    internal static ObjectResult SegmentEvicted(HttpResponse response)
    {
        response.Headers.RetryAfter = "1";
        return new ObjectResult(ErrorResponse.Of("segment_evicted", "The segment was replaced while opening; retry."))
        {
            StatusCode = StatusCodes.Status503ServiceUnavailable,
        };
    }

    /// <summary>A demuxed session serves the video track on the main playlist and one audio track per rendition; null track = the muxed file.</summary>
    private static bool TryTrack(TranscodeSession session, string? rendition, out uint? track)
    {
        track = null;
        if (rendition is null)
        {
            if (session.Plan.DemuxedAudio)
                track = 1;
            return true;
        }
        if (session.Plan.AudioRenditions.FirstOrDefault(r => r.Id == rendition) is not { } match)
            return false;
        track = match.TrackId;
        return true;
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
        return Content(HlsPlaylist.Subtitles(session.Timeline, PlayerQuery()), PlaylistType);
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
            return Content(await sessions.GetSubtitleSegmentAsync(session, stream, segment, ct, Requester()), WebVttSubtitles.ContentType);
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

    /// <summary>The player tag a master playlist hands out (<c>?p=</c>), carried by the media playlists into every segment URI.</summary>
    private const string PlayerParameter = "p";

    private static string PlayerQuery(int tag) => string.Create(System.Globalization.CultureInfo.InvariantCulture, $"?{PlayerParameter}={tag}");

    /// <summary>The query a media playlist passes on to its segments: the tag it was fetched with, if any.</summary>
    private string? PlayerQuery() => PlayerTag() is { } tag ? PlayerQuery(tag) : null;

    private int? PlayerTag()
        => Request.Query[PlayerParameter].ToString() is { Length: > 0 and <= 9 } raw && int.TryParse(raw, System.Globalization.NumberStyles.None, null, out var tag) && tag > 0
            ? tag
            : null;

    /// <summary>One player: its playlist tag, or its address and user agent when it fetched no tagged playlist.</summary>
    private string Requester()
    {
        if (PlayerTag() is { } tag)
            return string.Create(System.Globalization.CultureInfo.InvariantCulture, $"p:{tag}");
        var agent = Request.Headers.UserAgent.ToString();
        return $"a:{HttpContext.Connection.RemoteIpAddress}|{(agent.Length > 200 ? agent[..200] : agent)}";
    }

    private IActionResult Failure(TranscodeException e)
    {
        if (e.StatusCode is 503 or 504)
            Response.Headers.RetryAfter = "1";
        return StatusCode(e.StatusCode, ErrorResponse.Of(e.Code, e.Message));
    }

    private ObjectResult SplitFailure(Exception e, string? rendition, int? segment)
    {
        logger.LogError(e, "Could not split rendition {Rendition} (segment {Segment}) out of the muxed session output", rendition, segment);
        return StatusCode(StatusCodes.Status500InternalServerError,
            ErrorResponse.Of("rendition_split_failed", "The session output could not be split into this rendition."));
    }

    private NotFoundObjectResult UnknownRendition()
        => NotFound(ErrorResponse.Of("unknown_audio_rendition", "This session has no such audio rendition."));

    private NotFoundObjectResult Unknown()
        => NotFound(ErrorResponse.Of("unknown_transcode", "No transcode session exists for this token (stopped or expired)."));

    private void NoStore()
    {
        Response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
