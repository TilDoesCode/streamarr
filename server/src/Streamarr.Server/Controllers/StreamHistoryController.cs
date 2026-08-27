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

    private static StreamRecordSummaryResponse ToSummary(StreamRecordEntity r)
    {
        var failure = FailureFor(r);
        return new StreamRecordSummaryResponse
        {
            Token = r.Token ?? r.AttemptId,
            ReleaseId = r.ReleaseId,
            WorkId = r.WorkId,
            Title = r.Title,
            ResolvedReleaseId = r.ResolvedReleaseId,
            ResolvedTitle = r.ResolvedTitle,
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
            FailureKind = failure.Kind,
            FailureReason = failure.Reason,
        };
    }

    private static StreamRecordResponse ToDetail(StreamRecordEntity r)
    {
        var failure = FailureFor(r);
        return new StreamRecordResponse
        {
            Token = r.Token ?? r.AttemptId,
            ReleaseId = r.ReleaseId,
            WorkId = r.WorkId,
            Title = r.Title,
            ResolvedReleaseId = r.ResolvedReleaseId,
            ResolvedTitle = r.ResolvedTitle,
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
            FailureKind = failure.Kind,
            FailureReason = failure.Reason,
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

    private static (string? Kind, string? Reason) FailureFor(StreamRecordEntity record)
    {
        var evidence = record.Events
            .Where(e => e.Source == "error" || (e.Source == "repair" && e.Name == "Failed"))
            .OrderByDescending(e => e.AtUtc)
            .FirstOrDefault();
        if (evidence is not null)
        {
            if (evidence.Source == "repair")
                return ("repair", FirstNonEmpty(evidence.Detail, evidence.Name));

            var articleFailure = string.Equals(evidence.Category, "stream", StringComparison.OrdinalIgnoreCase)
                && (Contains(evidence.Name, "article")
                    || Contains(evidence.Name, "yenc")
                    || Contains(evidence.Detail, "article"));
            var kind = articleFailure
                ? "article"
                : string.IsNullOrWhiteSpace(evidence.Category)
                    ? evidence.Source.ToLowerInvariant()
                    : evidence.Category.ToLowerInvariant();
            return (kind, FirstNonEmpty(evidence.Detail, evidence.Name));
        }

        return record.FinalState?.ToLowerInvariant() switch
        {
            "dead" => ("availability", FirstNonEmpty(record.CloseReason, "Release unavailable.")),
            "error" => ("resolve", FirstNonEmpty(record.CloseReason, "Resolve failed.")),
            "invalidated" => ("article", FirstNonEmpty(record.CloseReason, "Release became unavailable while streaming.")),
            _ => (null, null),
        };
    }

    private static bool Contains(string? value, string fragment)
        => value?.Contains(fragment, StringComparison.OrdinalIgnoreCase) == true;

    private static string FirstNonEmpty(string? preferred, string fallback)
        => string.IsNullOrWhiteSpace(preferred) ? fallback : preferred;
}
