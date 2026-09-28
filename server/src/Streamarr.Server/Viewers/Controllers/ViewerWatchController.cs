using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>The signed-in viewer's watch state: progress reports, continue watching, next up, history and played flags.</summary>
[ApiController]
[Route("api/v1/viewer/watch")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
public sealed class ViewerWatchController(
    WatchStateService watch,
    NextUpService nextUp,
    ViewerAccountService accounts,
    ViewerContentPolicy policy) : ControllerBase
{
    private static readonly HashSet<string> Events = new(StringComparer.Ordinal) { "start", "progress", "stop" };

    /// <summary>Report playback of a movie or episode (start, periodic progress, stop).</summary>
    [HttpPost("progress")]
    [ProducesResponseType(typeof(WatchStateResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<WatchStateResponse>> Progress([FromBody] WatchProgressRequest request, CancellationToken ct)
    {
        var kind = request.Event?.Trim().ToLowerInvariant();
        if (kind is null || !Events.Contains(kind))
            return BadRequest(ErrorResponse.Of("invalid_event", "'event' must be one of: start, progress, stop."));
        if (request.PositionTicks < 0 || request.DurationTicks is < 0 ||
            Invalid(request.PlaybackId, 128) || Invalid(request.ReleaseId, 256) || Invalid(request.StreamToken, 256) || Invalid(request.Title, 300))
        {
            return BadRequest(ErrorResponse.Of("invalid_event", "One or more values are negative, too long or contain control characters."));
        }

        var state = await watch.ReportAsync(
            new ViewerContext(User.ViewerId(), User.Identity?.Name ?? string.Empty, User.FindFirst(ViewerAuth.DeviceClaim)?.Value ?? string.Empty),
            new WatchReport
            {
                Event = kind,
                Work = ViewerMappings.RequireWork(request.WorkId, playableOnly: true),
                PositionTicks = request.PositionTicks,
                DurationTicks = request.DurationTicks,
                PlaybackId = Clean(request.PlaybackId),
                ReleaseId = Clean(request.ReleaseId),
                StreamToken = Clean(request.StreamToken),
                Title = Clean(request.Title),
            },
            ct);
        return Ok(ViewerMappings.State(state));
    }

    /// <summary>Mark works played; season and series ids expand to all aired episodes via TMDB.</summary>
    [HttpPost("played")]
    [ProducesResponseType(typeof(WatchMarkResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public Task<ActionResult<WatchMarkResponse>> MarkPlayed([FromBody] WatchWorkIdsRequest request, CancellationToken ct)
        => MarkAsync(request, played: true, ct);

    /// <summary>Mark works unplayed (clears position, played flag and play count).</summary>
    [HttpPost("unplayed")]
    [ProducesResponseType(typeof(WatchMarkResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public Task<ActionResult<WatchMarkResponse>> MarkUnplayed([FromBody] WatchWorkIdsRequest request, CancellationToken ct)
        => MarkAsync(request, played: false, ct);

    /// <summary>Continue watching: works with a resume position, most recent first.</summary>
    [HttpGet("resume")]
    [ProducesResponseType(typeof(IReadOnlyList<WatchStateResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<WatchStateResponse>>> Resume([FromQuery] int limit = 20, CancellationToken ct = default)
        => Ok((await watch.ResumeAsync(User.ViewerId(), limit, ct)).Select(ViewerMappings.State).ToList());

    /// <summary>Hide a work from continue watching without changing its played state.</summary>
    [HttpDelete("resume/{workId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> RemoveFromResume(string workId, CancellationToken ct)
    {
        await watch.RemoveFromResumeAsync(User.ViewerId(), ViewerMappings.RequireWork(workId, playableOnly: true), ct);
        return NoContent();
    }

    /// <summary>The next episode to watch for each recently watched series.</summary>
    [HttpGet("next-up")]
    [ProducesResponseType(typeof(NextUpResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<NextUpResponse>> NextUp([FromQuery] int limit = 20, [FromQuery] string? seriesWorkId = null, CancellationToken ct = default)
    {
        string? series = null;
        if (seriesWorkId is not null)
        {
            var key = ViewerMappings.RequireWork(seriesWorkId, playableOnly: false);
            series = key.SeriesWorkId ?? throw ViewerProblem.BadRequest("invalid_work_id", "'seriesWorkId' must be a TV work id.");
        }
        var result = await nextUp.GetAsync(User.ViewerId(), series, limit, ct);
        return Ok(new NextUpResponse { Items = result.Items.Select(ViewerMappings.NextUp).ToList(), Incomplete = result.Incomplete });
    }

    /// <summary>Everything the viewer has played or started, most recent first.</summary>
    [HttpGet("history")]
    [ProducesResponseType(typeof(WatchHistoryResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<WatchHistoryResponse>> History([FromQuery] int limit = 50, [FromQuery] int offset = 0, CancellationToken ct = default)
    {
        var (items, total) = await watch.HistoryAsync(User.ViewerId(), limit, offset, ct);
        return Ok(new WatchHistoryResponse { Items = items.Select(ViewerMappings.State).ToList(), Total = total });
    }

    /// <summary>Watch state for specific movie/episode ids; unknown ids come back unplayed.</summary>
    [HttpPost("state")]
    [ProducesResponseType(typeof(IReadOnlyList<WatchStateResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<IReadOnlyList<WatchStateResponse>>> State([FromBody] WatchWorkIdsRequest request, CancellationToken ct)
    {
        var keys = ViewerMappings.RequireWorks(request.WorkIds, playableOnly: true);
        var found = (await watch.GetAsync(User.ViewerId(), keys.Select(k => k.WorkId).ToList(), ct))
            .ToDictionary(s => s.WorkId, StringComparer.Ordinal);
        return Ok(keys.Select(k => found.TryGetValue(k.WorkId, out var s) ? ViewerMappings.State(s) : ViewerMappings.EmptyState(k)).ToList());
    }

    /// <summary>All recorded episode states of one series.</summary>
    [HttpGet("series/{seriesWorkId}")]
    [ProducesResponseType(typeof(IReadOnlyList<WatchStateResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<WatchStateResponse>>> Series(string seriesWorkId, CancellationToken ct)
    {
        var series = ViewerMappings.RequireWork(seriesWorkId, playableOnly: false).SeriesWorkId
                     ?? throw ViewerProblem.BadRequest("invalid_work_id", "Expected a TV work id.");
        return Ok((await watch.GetSeriesAsync(User.ViewerId(), series, ct)).Select(ViewerMappings.State).ToList());
    }

    /// <summary>Whether the viewer's age limit allows a work, based on its TMDB certification.</summary>
    [HttpGet("~/api/v1/viewer/access/{workId}")]
    [ProducesResponseType(typeof(ContentAccessResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ContentAccessResponse>> Access(string workId, CancellationToken ct)
    {
        var key = ViewerMappings.RequireWork(workId, playableOnly: false);
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        return Ok(ViewerMappings.Access(await policy.EvaluateAsync(viewer, key, ct)));
    }

    private async Task<ActionResult<WatchMarkResponse>> MarkAsync(WatchWorkIdsRequest request, bool played, CancellationToken ct)
    {
        var keys = ViewerMappings.RequireWorks(request.WorkIds, playableOnly: false);
        var affected = await watch.SetPlayedAsync(User.ViewerId(), keys, played, ct);
        return Ok(new WatchMarkResponse { WorkIds = affected, Played = played });
    }

    private static bool Invalid(string? value, int max) => value is not null && (value.Length > max || value.Any(char.IsControl));

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
