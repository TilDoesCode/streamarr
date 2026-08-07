using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Services.Repair;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Repair job observability and control. Admin-scoped except the capability-token-bound
/// per-session status. Responses never contain message-ids, paths or credentials.
/// </summary>
[ApiController]
public class RepairsController(
    RepairCoordinator coordinator,
    RepairArtifactCache artifactCache,
    SessionManager sessionManager,
    IOptions<StreamarrOptions> options) : ControllerBase
{
    [HttpGet("api/v1/repairs")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(RepairOverviewResponse), StatusCodes.Status200OK)]
    public ActionResult<RepairOverviewResponse> Overview()
        => Ok(new RepairOverviewResponse
        {
            Enabled = coordinator.Enabled,
            Policy = options.Value.Repair.Policy == RepairPolicy.PreferRepair ? "preferRepair" : "whenNoFallback",
            Jobs = coordinator.ListJobs().Select(ToResponse).ToList(),
            Artifacts = artifactCache.Snapshots()
                .Select(a => new RepairArtifactResponse
                {
                    Fingerprint = a.Fingerprint,
                    ReleaseTitle = a.ReleaseTitle,
                    Bytes = a.Bytes,
                    CreatedUtc = a.CreatedUtc,
                    LastAccessUtc = a.LastAccessUtc,
                    PinCount = a.PinCount,
                })
                .ToList(),
            CacheBytesUsed = artifactCache.TotalBytes,
            CacheBudgetBytes = options.Value.Repair.CacheBudgetBytes,
        });

    [HttpGet("api/v1/repairs/{jobId}")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(RepairJobResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<RepairJobResponse> Get(string jobId)
    {
        if (jobId.Length > 64)
            return NotFound(ErrorResponse.Of("unknown_repair_job", "No repair job exists with this id."));
        var snapshot = coordinator.GetJob(jobId);
        return snapshot is null
            ? NotFound(ErrorResponse.Of("unknown_repair_job", "No repair job exists with this id."))
            : Ok(ToResponse(snapshot));
    }

    /// <summary>Idempotent manual start: an existing active job for the release is returned as-is.</summary>
    [HttpPost("api/v1/repairs")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(RepairJobResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<RepairJobResponse>> Start(
        [FromBody] StartRepairRequest request, CancellationToken ct)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.ReleaseId)
            || request.ReleaseId.Length > 256
            || request.ReleaseId.Any(char.IsControl)
            || request.WorkId is not null && string.IsNullOrWhiteSpace(request.WorkId)
            || request.WorkId?.Length > 256
            || request.WorkId?.Any(char.IsControl) == true)
        {
            return BadRequest(ErrorResponse.Of(
                "invalid_repair_request",
                "A valid releaseId and optional workId are required."));
        }

        RepairJobHandle? handle;
        try
        {
            handle = await coordinator.GetOrStartJobAsync(
                request.ReleaseId, request.WorkId, releaseTitle: null, RepairTrigger.Manual, ct);
        }
        catch (ReleaseNotFoundException)
        {
            return NotFound(ErrorResponse.Of("unknown_release", "No release is registered with this id."));
        }

        if (handle is null)
        {
            return Conflict(ErrorResponse.Of(
                "repair_unavailable",
                "Repair is disabled or the release cannot be analyzed for repair."));
        }
        return Accepted(ToResponse(handle.Snapshot()));
    }

    [HttpPost("api/v1/repairs/{jobId}/cancel")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult Cancel(string jobId)
        => jobId.Length <= 64 && coordinator.CancelJob(jobId)
            ? NoContent()
            : NotFound(ErrorResponse.Of("unknown_repair_job", "No active repair job exists with this id."));

    /// <summary>
    /// Capability-token-bound repair status for a live session: possession of the stream
    /// token authorizes exactly this release's repair progress (same model as /timeline).
    /// </summary>
    [HttpGet("api/v1/sessions/{token}/repair")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(SessionRepairStatusResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<SessionRepairStatusResponse> SessionStatus(string token)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (token.Length > 128 || !sessionManager.TryGetSession(token, out var session) || session is null)
            return NotFound(ErrorResponse.Of("unknown_stream", "No live stream exists for this token."));

        var snapshot = coordinator.GetJobByRelease(session.Session.ReleaseId);
        var playability = snapshot?.State switch
        {
            null => RepairPlayability.RemoteReady.ToApi(),
            RepairState.Ready => RepairPlayability.RepairedReady.ToApi(),
            RepairState.Failed or RepairState.Cancelled or RepairState.Evicted => RepairPlayability.Unavailable.ToApi(),
            _ => RepairPlayability.Repairing.ToApi(),
        };
        return Ok(new SessionRepairStatusResponse
        {
            Playability = playability,
            Repair = snapshot?.ToStatusInfo(retryAfterSeconds: snapshot.IsTerminal ? null : 5),
        });
    }

    private static RepairJobResponse ToResponse(RepairJobSnapshot snapshot)
        => new()
        {
            JobId = snapshot.JobId,
            Fingerprint = snapshot.Fingerprint,
            ReleaseId = snapshot.ReleaseId,
            WorkId = snapshot.WorkId,
            ReleaseTitle = snapshot.ReleaseTitle,
            Disposition = snapshot.Disposition.ToApi(),
            State = snapshot.State.ToApi(),
            Phase = RepairStatusMapper.PhaseOf(snapshot.State),
            CreatedAtUtc = snapshot.CreatedAtUtc,
            CompletedAtUtc = snapshot.CompletedAtUtc,
            ProcessedBytes = snapshot.ProcessedBytes,
            TotalBytes = snapshot.TotalBytes,
            ProgressPercent = snapshot.ProgressPercent,
            SourceBytesDownloaded = snapshot.SourceBytesDownloaded,
            ParityBytesDownloaded = snapshot.ParityBytesDownloaded,
            DamagedBlocks = snapshot.DamagedBlocks,
            RecoveryBlocksUsed = snapshot.RecoveryBlocksUsed,
            Waiters = snapshot.Waiters,
            EtaSeconds = snapshot.EtaSeconds,
            FailureReason = snapshot.FailureReason,
            Events = snapshot.Events
                .Select(e => new RepairJobEventResponse(e.AtUtc, e.State.ToApi(), e.Message))
                .ToList(),
        };
}
