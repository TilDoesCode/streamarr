using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Two-phase playback admission keeps slow preparation off the initial HTTP request.
/// Jellyfin's global live-stream lock remains held while OpenMediaSource polls it.
/// Uses the same machine-auth posture and validation as POST /api/v1/resolve.
/// </summary>
[ApiController]
[Route("api/v1/playback-sessions")]
public class PlaybackSessionsController(
    PlaybackAdmissionService admissions,
    IServer server) : ControllerBase
{
    /// <summary>Milliseconds the POST may spend waiting for the fast path.</summary>
    private const int AdmissionBudgetMs = 3_000;

    [HttpPost]
    [ProducesResponseType(typeof(PlaybackAdmissionResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(PlaybackAdmissionResponse), StatusCodes.Status202Accepted)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<PlaybackAdmissionResponse>> Admit(
        [FromBody] ResolveRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.ReleaseId) || request.ReleaseId.Length > 256 ||
            request.ReleaseId.Any(char.IsControl) ||
            request.WorkId is not null && string.IsNullOrWhiteSpace(request.WorkId) ||
            request.WorkId?.Length > 256 || request.WorkId?.Any(char.IsControl) == true ||
            request.Client?.Length > 64 || request.Client?.Any(char.IsControl) == true ||
            request.RequestedById?.Length > 256 || request.RequestedById?.Any(char.IsControl) == true ||
            request.RequestedByName?.Length > 256 || request.RequestedByName?.Any(char.IsControl) == true)
        {
            return BadRequest(ErrorResponse.Of("invalid_admission", "A valid releaseId is required."));
        }

        var localBase = LocalBaseUrl();
        var requestedById = request.RequestedById;
        var requestedByName = request.RequestedByName;
        if (string.IsNullOrWhiteSpace(requestedById)
            && User.IsInRole(AuthRoles.Admin)
            && !string.IsNullOrWhiteSpace(User.Identity?.Name))
        {
            requestedById = $"streamarr-admin:{User.Identity.Name}";
            requestedByName ??= User.Identity.Name;
        }

        try
        {
            var response = await admissions.AdmitAsync(
                request,
                requestedById,
                requestedByName,
                token => $"/api/v1/stream/{token}",
                token => $"{localBase}/api/v1/stream/{token}",
                TimeSpan.FromMilliseconds(AdmissionBudgetMs),
                ct);
            return response.Phase == "preparing" ? Accepted(response) : Ok(response);
        }
        catch (ResourceCapacityException)
        {
            Response.Headers.RetryAfter = "2";
            return StatusCode(
                StatusCodes.Status429TooManyRequests,
                ErrorResponse.Of("admission_capacity", "Too many playback admissions are in flight."));
        }
    }

    [HttpGet("{admissionId}")]
    [ProducesResponseType(typeof(PlaybackAdmissionResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<PlaybackAdmissionResponse> Status(string admissionId)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        var status = admissions.GetStatus(admissionId);
        return status is null
            ? NotFound(ErrorResponse.Of("unknown_admission", "No playback admission exists with this id."))
            : Ok(status);
    }

    [HttpPost("{admissionId}/claim")]
    [ProducesResponseType(typeof(PlaybackAdmissionResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    public ActionResult<PlaybackAdmissionResponse> Claim(string admissionId)
    {
        var outcome = admissions.TryClaim(admissionId, out var response);
        return outcome switch
        {
            PlaybackAdmissionClaimOutcome.Claimed => Ok(response),
            PlaybackAdmissionClaimOutcome.Preparing => Conflict(ErrorResponse.Of(
                "admission_preparing",
                "The playback admission is still preparing.")),
            _ => NotFound(ErrorResponse.Of(
                "unknown_admission",
                "No playback admission exists with this id.")),
        };
    }

    [HttpDelete("{admissionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult Cancel(string admissionId)
    {
        admissions.Cancel(admissionId);
        return NoContent();
    }

    private string LocalBaseUrl()
    {
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses;
        var address = addresses?.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                      ?? addresses?.FirstOrDefault();
        if (string.IsNullOrEmpty(address))
            // TestServer has no reachable listener. Never fall back to the untrusted
            // Host header with a capability token; ffprobe will fail softly instead.
            return "http://127.0.0.1:1";

        var loopback = address
            .Replace("://+", "://127.0.0.1")
            .Replace("://*", "://127.0.0.1")
            .Replace("0.0.0.0", "127.0.0.1")
            .Replace("[::]", "127.0.0.1");
        return new Uri(loopback).GetLeftPart(UriPartial.Authority);
    }
}
