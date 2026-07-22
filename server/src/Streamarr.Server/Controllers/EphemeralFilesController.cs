using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/ephemeral-files")]
public sealed class EphemeralFilesController(SessionManager sessions) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<EphemeralFileResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<EphemeralFileResponse>> List()
        => Ok(sessions.ListSessions().Select(active =>
        {
            var storage = active.CachedStorage;
            return new EphemeralFileResponse
            {
                Token = active.Token,
                ReleaseId = active.Session.ReleaseId,
                WorkId = active.Session.WorkId,
                Title = active.Title,
                FileName = active.File.FileName,
                State = active.Session.State.ToString().ToLowerInvariant(),
                Container = active.Session.Container,
                Client = active.Session.Client,
                RequestedById = active.Session.RequestedById,
                RequestedByName = active.Session.RequestedByName,
                SizeBytes = active.Session.SizeBytes,
                BytesServed = active.BytesServed,
                ChunksQueried = active.ChunksQueried,
                TotalChunks = active.File.SegmentIds.Count,
                EstimatedStreamedPercent = active.EstimatedStreamedPercent,
                CachedChunks = storage.Count,
                StorageBytes = storage.Bytes,
                IsStreaming = active.IsStreaming,
                CreatedAt = active.Session.CreatedAt,
                LastAccessedAt = active.Session.LastAccessedAt,
                PurgeAt = active.ExpiresAt,
            };
        }).ToList());

    /// <summary>
    /// Manually purges one idle ephemeral file from the server-owned cache. Refuses with 409
    /// while the file is being actively streamed so operator cleanup never interrupts playback.
    /// </summary>
    [HttpPost("{token}/purge")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public IActionResult Purge(string token)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        return sessions.PurgeSession(token) switch
        {
            PurgeOutcome.Purged => NoContent(),
            PurgeOutcome.Streaming => Conflict(ErrorResponse.Of(
                "stream_active",
                "This ephemeral file is being actively streamed and cannot be purged.")),
            _ => NotFound(ErrorResponse.Of(
                "unknown_ephemeral_file",
                "No live ephemeral file exists for this token.")),
        };
    }
}
