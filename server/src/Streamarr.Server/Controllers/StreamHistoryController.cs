using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/streams(/{token}) — the permanent stream-attempt history (BRIEF §11 console):
/// the last <c>MaxRetainedStreams</c> resolve attempts, live or long since closed, each with
/// its full diagnostic event timeline. Distinct from the live-only <c>/api/v1/sessions</c> and
/// the byte-range <c>/api/v1/stream/{token}</c>.
/// </summary>
[ApiController]
[Route("api/v1/streams")]
[Authorize(Policy = AuthRoles.AdminPolicy)]
public class StreamHistoryController(StreamHistoryRecorder historyRecorder) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<StreamRecordSummaryResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<StreamRecordSummaryResponse>>> List(
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
        => Ok((await historyRecorder.ListAsync(limit, ct)).Select(ToSummary).ToList());

    [HttpGet("{token}")]
    [ProducesResponseType(typeof(StreamRecordResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<StreamRecordResponse>> Get(string token, CancellationToken ct)
    {
        var record = await historyRecorder.GetAsync(token, ct);
        if (record is null)
            return NotFound(ErrorResponse.Of("unknown_stream", "No retained stream record exists for this token."));

        return Ok(ToDetail(record));
    }

    private static StreamRecordSummaryResponse ToSummary(StreamRecordEntity r) => new()
    {
        Token = r.Token ?? r.AttemptId,
        ReleaseId = r.ReleaseId,
        WorkId = r.WorkId,
        Title = r.Title,
        Container = r.Container,
        SizeBytes = r.SizeBytes,
        BytesServed = r.BytesServed,
        NntpCommandsTotal = r.NntpCommandsTotal,
        Client = r.Client,
        RequestedById = r.RequestedById,
        RequestedByName = r.RequestedByName,
        CreatedAt = r.CreatedAt,
        ClosedAt = r.ClosedAt,
        FinalState = r.FinalState,
        CloseReason = r.CloseReason,
    };

    private static StreamRecordResponse ToDetail(StreamRecordEntity r) => new()
    {
        Token = r.Token ?? r.AttemptId,
        ReleaseId = r.ReleaseId,
        WorkId = r.WorkId,
        Title = r.Title,
        Container = r.Container,
        SizeBytes = r.SizeBytes,
        BytesServed = r.BytesServed,
        NntpCommandsTotal = r.NntpCommandsTotal,
        Client = r.Client,
        RequestedById = r.RequestedById,
        RequestedByName = r.RequestedByName,
        CreatedAt = r.CreatedAt,
        ClosedAt = r.ClosedAt,
        FinalState = r.FinalState,
        CloseReason = r.CloseReason,
        TimelineStartedAt = r.TimelineStartedAt,
        Timeline = [.. r.Events
            .Where(e => e.Source == "ttff")
            .OrderBy(e => e.StartMs)
            .Select(e => new TtffSpanResponse
            {
                Name = e.Name,
                Category = e.Category,
                StartMs = e.StartMs ?? 0,
                DurationMs = e.DurationMs ?? 0,
                Detail = e.Detail,
            })],
        Events = [.. r.Events
            .OrderBy(e => e.AtUtc)
            .Select(e => new StreamEventResponse
            {
                AtUtc = e.AtUtc,
                Source = e.Source,
                Category = e.Category,
                Name = e.Name,
                Detail = e.Detail,
                StartMs = e.StartMs,
                DurationMs = e.DurationMs,
            })],
    };
}
