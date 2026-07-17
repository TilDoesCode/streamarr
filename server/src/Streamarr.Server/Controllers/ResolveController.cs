using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Controllers;

/// <summary>POST /api/v1/resolve (BRIEF §6.2).</summary>
[ApiController]
[Route("api/v1")]
public class ResolveController(
    ResolveService resolveService,
    StreamarrMetrics metrics,
    IServer server,
    PushoverNotificationService notifications) : ControllerBase
{
    [HttpPost("resolve")]
    [ProducesResponseType(typeof(ResolveResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<ResolveResponse>> Resolve([FromBody] ResolveRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.ReleaseId) || request.ReleaseId.Length > 256 ||
            request.ReleaseId.Any(char.IsControl) ||
            request.WorkId is not null && string.IsNullOrWhiteSpace(request.WorkId) ||
            request.WorkId?.Length > 256 || request.WorkId?.Any(char.IsControl) == true ||
            request.Client?.Length > 64 || request.Client?.Any(char.IsControl) == true ||
            request.RequestedById?.Length > 256 || request.RequestedById?.Any(char.IsControl) == true ||
            request.RequestedByName?.Length > 256 || request.RequestedByName?.Any(char.IsControl) == true)
        {
            return BadRequest(ErrorResponse.Of("invalid_resolve", "A valid releaseId and client are required."));
        }

        var localBase = LocalBaseUrl();

        try
        {
            var response = await resolveService.ResolveAsync(
                request.ReleaseId,
                request.WorkId,
                request.Client,
                request.RequestedById,
                request.RequestedByName,
                request.AutoFallback,
                token => $"/api/v1/stream/{token}",
                token => $"{localBase}/api/v1/stream/{token}",
                ct);
            metrics.ResolveCompleted(viaFallback: response.FallbackFromReleaseId is not null);
            notifications.Enqueue(new NotificationEvent(
                NotificationEventKind.ResolveSucceeded,
                "Release resolved",
                response.FallbackFromReleaseId is null
                    ? "A release was prepared for streaming."
                    : "A fallback release was prepared for streaming.",
                request.ReleaseId,
                request.RequestedByName,
                null,
                request.ReleaseId));
            return Ok(response);
        }
        catch (ReleaseNotFoundException e)
        {
            NotifyResolveFailure(request, "The requested release was not found.");
            return NotFound(ErrorResponse.Of("release_not_found", e.Message));
        }
        catch (NoPlayableFileException e)
        {
            NotifyResolveFailure(request, e.Message);
            return UnprocessableEntity(ErrorResponse.Of("no_playable_file", e.Message));
        }
        catch (NzbOriginNotAllowedException e)
        {
            NotifyResolveFailure(request, e.Message);
            return UnprocessableEntity(
                ErrorResponse.OfHostNotAllowed("nzb_host_not_allowed", e.Message, e.Host, e.IndexerId));
        }
        catch (InvalidDataException e)
        {
            NotifyResolveFailure(request, e.Message);
            return UnprocessableEntity(ErrorResponse.Of("invalid_release", e.Message));
        }
        catch (ResourceCapacityException)
        {
            NotifyResolveFailure(request, "Streaming capacity is currently reached.");
            Response.Headers.RetryAfter = "1";
            return StatusCode(StatusCodes.Status429TooManyRequests,
                ErrorResponse.Of("capacity_reached", "Server streaming capacity is currently reached; retry shortly."));
        }
        catch (UsenetException e)
        {
            NotifyResolveFailure(request, e.Message);
            return StatusCode(StatusCodes.Status502BadGateway,
                ErrorResponse.Of("usenet_unreachable", e.Message));
        }
        catch (Exception e) when (e is HttpRequestException or IOException)
        {
            NotifyResolveFailure(request, "The NZB could not be downloaded.");
            return StatusCode(StatusCodes.Status502BadGateway,
                ErrorResponse.Of("nzb_fetch_failed", "The NZB could not be downloaded from its configured indexer."));
        }
    }

    private void NotifyResolveFailure(ResolveRequest request, string message)
        => notifications.Enqueue(new NotificationEvent(
            NotificationEventKind.ResolveFailed,
            "Resolve failed",
            message,
            $"{request.ReleaseId}:{message}",
            request.RequestedByName,
            null,
            request.ReleaseId));

    /// <summary>
    /// A loopback-reachable base URL of this server for the in-process ffprobe run.
    /// </summary>
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
