using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.MyList;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>The signed-in viewer's list ("My List"): started series (added automatically), titles added by the viewer, their status and progress, and new available episodes.</summary>
[ApiController]
[Route("api/v1/viewer/list")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
[ViewerModelStateFilter]
public sealed class ViewerListController(MyListService list, ViewerAccountService accounts, ViewerContentPolicy policy) : ControllerBase
{
    /// <summary>All entries (new ones first, then by recent activity), optionally only one status; status and progress are derived from watch state, TMDB and release availability on every call.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(MyListResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<MyListResponse>> List([FromQuery] string? status = null, [FromQuery] int limit = 200, [FromQuery] int offset = 0, CancellationToken ct = default)
    {
        if (status is not null && !MyListStatus.All.Contains(status))
            return BadRequest(ErrorResponse.Of("invalid_status", "'status' must be want_to_watch, watching, caught_up or watched."));
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        return Ok(await list.ListAsync(viewer, status, limit, offset, ct));
    }

    /// <summary>Counts for a badge: entries with a new available episode and entries per status.</summary>
    [HttpGet("summary")]
    [ProducesResponseType(typeof(MyListSummaryResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<MyListSummaryResponse>> Summary(CancellationToken ct)
    {
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        return Ok(await list.SummaryAsync(viewer, ct));
    }

    /// <summary>Whether a movie, series or season is on the list (with its entry); seasons also say whether the whole series is.</summary>
    [HttpGet("{workId}")]
    [ProducesResponseType(typeof(MyListEntryStatusResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<MyListEntryStatusResponse>> Get(string workId, CancellationToken ct)
    {
        var key = ViewerMappings.RequireWork(workId, playableOnly: false);
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        return Ok(await list.StatusAsync(viewer, key, ct));
    }

    /// <summary>Add a movie, series or season (again, also after removing it); an optional <c>status</c> (want_to_watch or watched) holds until the next playback.</summary>
    [HttpPut("{workId}")]
    [ProducesResponseType(typeof(MyListItemDto), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<MyListItemDto>> Add(
        string workId, [FromBody(EmptyBodyBehavior = EmptyBodyBehavior.Allow)] MyListAddRequest? request, CancellationToken ct)
    {
        var key = ViewerMappings.RequireWork(workId, playableOnly: false);
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        var access = await policy.EvaluateAsync(viewer, key, ct);
        if (!access.Allowed)
            throw ViewerContentPolicy.AgeRestricted(access);
        return Ok(await list.AddAsync(viewer, key, request?.Status, ct));
    }

    /// <summary>Remove an entry; a removed series is not added again automatically when the viewer keeps watching it.</summary>
    [HttpDelete("{workId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Remove(string workId, CancellationToken ct)
    {
        await list.RemoveAsync(User.ViewerId(), ViewerMappings.RequireWork(workId, playableOnly: false), ct);
        return NoContent();
    }

    /// <summary>Clear the new flag (a series id also clears its seasons); playing the new episode clears it too.</summary>
    [HttpPost("{workId}/seen")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Seen(string workId, CancellationToken ct)
    {
        await list.SeenAsync(User.ViewerId(), ViewerMappings.RequireWork(workId, playableOnly: false), ct);
        return NoContent();
    }
}
