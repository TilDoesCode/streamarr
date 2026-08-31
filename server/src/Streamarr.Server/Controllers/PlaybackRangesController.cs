using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/playback-ranges — watched-time intervals per playback scope, folded from
/// front-end heartbeats. The debugging complement to /api/v1/events: not "where is the
/// playhead" but "which parts of the timeline were actually watched, via which release".
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/playback-ranges")]
public sealed class PlaybackRangesController(IDbContextFactory<StreamarrDbContext> dbFactory) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<PlaybackRangeResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<PlaybackRangeResponse>>> List(
        [FromQuery] int limit = 200,
        CancellationToken ct = default)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        // SQLite cannot ORDER BY DateTimeOffset; the table is bounded (≤500 rows), so sort in memory.
        var rows = (await db.PlaybackRanges.AsNoTracking().ToListAsync(ct))
            .OrderByDescending(r => r.UpdatedAt).ThenByDescending(r => r.Id)
            .Take(Math.Clamp(limit, 1, 500))
            .ToList();

        return Ok(rows.Select(row => new PlaybackRangeResponse
        {
            WorkId = row.WorkId,
            Title = NullIfEmpty(row.Title),
            Source = row.Source,
            PlaybackSessionId = NullIfEmpty(row.PlaybackSessionId),
            ExternalUserId = NullIfEmpty(row.ExternalUserId),
            ExternalUserName = NullIfEmpty(row.ExternalUserName),
            DeviceName = NullIfEmpty(row.DeviceName),
            DurationTicks = row.DurationTicks,
            PositionTicks = row.PositionTicks,
            LastSessionToken = NullIfEmpty(row.LastSessionToken),
            LastReleaseId = NullIfEmpty(row.LastReleaseId),
            StartedAt = row.StartedAt,
            UpdatedAt = row.UpdatedAt,
            Ranges = PlaybackRangeRecorder.Parse(row.RangesJson)
                .Select(span => new PlaybackRangeSpanResponse
                {
                    StartTicks = span.StartTicks,
                    EndTicks = span.EndTicks,
                    SessionToken = span.SessionToken,
                    ReleaseId = span.ReleaseId,
                })
                .ToList(),
        }).ToList());
    }

    private static string? NullIfEmpty(string value)
        => string.IsNullOrWhiteSpace(value) ? null : value;
}
