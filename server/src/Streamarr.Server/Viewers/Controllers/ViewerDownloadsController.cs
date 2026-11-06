using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Device downloads: which versions play offline as they are, the similarity plan for a season, asynchronous preparation with a hard direct-play check, and the device's download records.</summary>
[ApiController]
[Route("api/v1/viewer/downloads")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
[ViewerModelStateFilter]
[ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
[ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
public sealed class ViewerDownloadsController(ViewerDownloadService downloads, ViewerAccountService accounts) : ControllerBase
{
    /// <summary>Read-only (POST for the full device profile): every version of a movie or episode with whether its original file plays as it is on this device (native direct, else VLC direct), the size it needs and the recommended download.</summary>
    [HttpPost("candidates")]
    [ProducesResponseType(typeof(DownloadCandidatesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<DownloadCandidatesResponse>> Candidates([FromBody] DownloadCandidatesRequest request, CancellationToken ct)
        => Ok(await downloads.CandidatesAsync(await accounts.GetAsync(User.ViewerId(), ct), request, AcceptLanguage(), ct));

    /// <summary>Read-only: a season's packs (episodes each covers, whole and per-episode size, offline playability) and per episode its candidates; uses the season's cached version search.</summary>
    [HttpPost("candidates/season")]
    [ProducesResponseType(typeof(DownloadSeasonCandidatesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<DownloadSeasonCandidatesResponse>> SeasonCandidates([FromBody] DownloadSeasonCandidatesRequest request, CancellationToken ct)
        => Ok(await downloads.SeasonCandidatesAsync(await accounts.GetAsync(User.ViewerId(), ct), request, AcceptLanguage(), ct));

    /// <summary>Read-only: for each episode the downloadable release most similar to the anchor version, graded (<c>same_release</c>, <c>same_variant</c>, <c>same_group</c>, <c>best_available</c>, <c>none</c>).</summary>
    [HttpPost("plan")]
    [ProducesResponseType(typeof(DownloadPlanResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<DownloadPlanResponse>> Plan([FromBody] DownloadPlanRequest request, CancellationToken ct)
        => Ok(await downloads.PlanAsync(await accounts.GetAsync(User.ViewerId(), ct), request, AcceptLanguage(), ct));

    /// <summary>Starts preparing a download of one version (resolve with health check, probe, hard check that the file plays as it is on the device); poll <c>GET {downloadId}</c>.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(DownloadResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<DownloadResponse>> Prepare([FromBody] DownloadPrepareRequest request, CancellationToken ct)
    {
        var response = await downloads.PrepareAsync(Caller(), await accounts.GetAsync(User.ViewerId(), ct), request, ct);
        return AcceptedAtAction(nameof(Get), new { downloadId = response.DownloadId }, response);
    }

    /// <summary>The viewer's downloads, newest first; <c>device=this</c> keeps the ones of this device (this session, or <c>deviceId</c>).</summary>
    [HttpGet]
    [ProducesResponseType(typeof(DownloadListResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<DownloadListResponse>> List([FromQuery] string? device = null, [FromQuery] string? deviceId = null, CancellationToken ct = default)
        => Ok(await downloads.ListAsync(Caller(), await accounts.GetAsync(User.ViewerId(), ct), device, deviceId, ct));

    /// <summary>The download's state; once <c>ready</c> it carries the file URL, exact size, media info and engine. <c>waitMs</c> (up to 10000) long-polls until the state changes.</summary>
    [HttpGet("{downloadId}")]
    [ProducesResponseType(typeof(DownloadResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<DownloadResponse>> Get(string downloadId, [FromQuery] int waitMs = 0, [FromQuery] string? deviceId = null, CancellationToken ct = default)
        => Ok(await downloads.GetAsync(Caller(), downloadId, waitMs, deviceId, ct));

    /// <summary>Extends the file capability (<c>expiresAt</c>); the URL stays the same. Checks the age gate and the download permission again.</summary>
    [HttpPost("{downloadId}/renew")]
    [ProducesResponseType(typeof(DownloadResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<DownloadResponse>> Renew(string downloadId, CancellationToken ct)
        => Ok(await downloads.RenewAsync(Caller(), await accounts.GetAsync(User.ViewerId(), ct), downloadId, ct));

    /// <summary>The device has the whole file: the download is <c>completed</c>, its stream session is released and its file URL stops working.</summary>
    [HttpPost("{downloadId}/complete")]
    [ProducesResponseType(typeof(DownloadResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<DownloadResponse>> Complete(string downloadId, [FromBody] DownloadCompleteRequest? request, CancellationToken ct)
        => Ok(await downloads.CompleteAsync(Caller(), downloadId, request ?? new DownloadCompleteRequest(), ct));

    /// <summary>Removed on the device or cancelled: stops its preparation, ends its transfers and forgets it.</summary>
    [HttpDelete("{downloadId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string downloadId, CancellationToken ct)
    {
        await downloads.DeleteAsync(Caller(), downloadId, ct);
        return NoContent();
    }

    private string AcceptLanguage() => Request.Headers.AcceptLanguage.ToString();

    private ViewerCaller Caller()
        => new(User.ViewerId(), User.SessionId(), User.Identity?.Name ?? string.Empty, User.FindFirst(ViewerAuth.DeviceClaim)?.Value ?? string.Empty);
}
