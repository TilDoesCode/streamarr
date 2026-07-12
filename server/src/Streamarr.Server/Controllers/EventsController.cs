using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// POST /api/v1/events — ingests playback events from any front-end into SQLite
/// (BRIEF §6.1 module 7 / §6.2). This is how watch state escapes a front-end's own DB.
/// </summary>
[ApiController]
[Route("api/v1/events")]
public class EventsController(WatchEventService events) : ControllerBase
{
    private static readonly HashSet<string> Kinds = new(StringComparer.OrdinalIgnoreCase) { "start", "progress", "stop" };

    [HttpPost]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Record([FromBody] EventRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.ReleaseId))
            return BadRequest(ErrorResponse.Of("invalid_event", "A non-empty 'releaseId' is required."));
        if (string.IsNullOrWhiteSpace(request.Event) || !Kinds.Contains(request.Event))
            return BadRequest(ErrorResponse.Of("invalid_event", "'event' must be one of: start, progress, stop."));

        await events.RecordAsync(new WatchEventWrite
        {
            ReleaseId = request.ReleaseId,
            WorkId = request.WorkId,
            Event = request.Event.ToLowerInvariant(),
            PositionTicks = request.PositionTicks,
            Source = request.Source,
        }, ct);

        return Accepted();
    }
}
