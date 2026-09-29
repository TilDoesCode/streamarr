using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Viewer playback: asynchronous preparation (resolve, fallback, repair, plan, start) with a pollable state, switches and stop.</summary>
[ApiController]
[Route("api/v1/viewer/playback")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
[ViewerModelStateFilter]
[ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
public sealed class ViewerPlaybackController(ViewerPlaybackService playbacks, ViewerAccountService accounts) : ControllerBase
{
    /// <summary>Starts preparing a playback; poll <c>GET {playbackId}</c> until <c>ready</c> or <c>failed</c>.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(PlaybackResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<PlaybackResponse>> Start([FromBody] PlaybackStartRequest request, CancellationToken ct)
    {
        var response = await playbacks.StartAsync(Caller(), await accounts.GetAsync(User.ViewerId(), ct), request, ct);
        NoStore();
        return AcceptedAtAction(nameof(Get), new { playbackId = response.PlaybackId }, response);
    }

    /// <summary>The playback's state; once <c>ready</c> it carries the URL, method, engine, media info and why.</summary>
    [HttpGet("{playbackId}")]
    [ProducesResponseType(typeof(PlaybackResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<PlaybackResponse> Get(string playbackId)
    {
        NoStore();
        return Ok(playbacks.Get(Caller(), playbackId));
    }

    /// <summary>Re-plans at a position with another audio/subtitle track, engine, quality or version; the previous URL stays valid for a short grace period after the new one is ready.</summary>
    [HttpPost("{playbackId}/switch")]
    [ProducesResponseType(typeof(PlaybackResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<PlaybackResponse>> Switch(string playbackId, [FromBody] PlaybackSwitchRequest request, CancellationToken ct)
    {
        var response = await playbacks.SwitchAsync(Caller(), await accounts.GetAsync(User.ViewerId(), ct), playbackId, request, ct);
        NoStore();
        return AcceptedAtAction(nameof(Get), new { playbackId = response.PlaybackId }, response);
    }

    /// <summary>Ends the playback: stops its remux/transcode sessions and frees the stream slot.</summary>
    [HttpPost("{playbackId}/stop")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Stop(string playbackId)
    {
        await playbacks.StopAsync(Caller(), playbackId, "stopped by the viewer");
        return NoContent();
    }

    private ViewerCaller Caller()
        => new(User.ViewerId(), User.SessionId(), User.Identity?.Name ?? string.Empty, User.FindFirst(ViewerAuth.DeviceClaim)?.Value ?? string.Empty);

    private void NoStore() => Response.Headers.CacheControl = "private, no-store, max-age=0";
}
