using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;
using Streamarr.Server.Auth;
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
        if (request.ReleaseId.Length > 256 || request.WorkId?.Length > 256 || request.Source?.Length > 64 ||
            request.PlaybackSessionId?.Length > 256 || request.ExternalUserId?.Length > 256 ||
            request.ExternalUserName?.Length > 256 || request.DeviceName?.Length > 256 ||
            request.PositionTicks is < 0 ||
            request.ReleaseId.Any(char.IsControl) || request.WorkId?.Any(char.IsControl) == true ||
            request.Source?.Any(char.IsControl) == true ||
            request.PlaybackSessionId?.Any(char.IsControl) == true ||
            request.ExternalUserId?.Any(char.IsControl) == true ||
            request.ExternalUserName?.Any(char.IsControl) == true ||
            request.DeviceName?.Any(char.IsControl) == true)
            return BadRequest(ErrorResponse.Of("invalid_event", "One or more event values are outside their allowed range."));

        await events.RecordAsync(new WatchEventWrite
        {
            ReleaseId = request.ReleaseId,
            WorkId = request.WorkId,
            Event = request.Event.ToLowerInvariant(),
            PositionTicks = request.PositionTicks,
            Source = request.Source,
            PlaybackSessionId = request.PlaybackSessionId,
            ExternalUserId = request.ExternalUserId,
            ExternalUserName = request.ExternalUserName,
            DeviceName = request.DeviceName,
        }, ct);

        return Accepted();
    }

    [HttpGet]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<StreamingHistoryResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<StreamingHistoryResponse>>> List(
        [FromQuery] int limit = 200,
        CancellationToken ct = default)
        => Ok((await events.RecentAsync(limit, ct)).Select(entry => new StreamingHistoryResponse
        {
            Id = entry.Id,
            ReleaseId = entry.ReleaseId,
            WorkId = entry.WorkId,
            Event = entry.Event,
            PositionTicks = entry.PositionTicks,
            Source = entry.Source,
            PlaybackSessionId = NullIfEmpty(entry.PlaybackSessionId),
            ExternalUserId = NullIfEmpty(entry.ExternalUserId),
            ExternalUserName = NullIfEmpty(entry.ExternalUserName),
            DeviceName = NullIfEmpty(entry.DeviceName),
            ReceivedAt = entry.ReceivedAt,
        }).ToList());

    private static string? NullIfEmpty(string value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
