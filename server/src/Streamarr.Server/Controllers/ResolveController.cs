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
public class ResolveController(ResolveService resolveService, IServer server) : ControllerBase
{
    [HttpPost("resolve")]
    [ProducesResponseType(typeof(ResolveResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status422UnprocessableEntity)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<ResolveResponse>> Resolve([FromBody] ResolveRequest request, CancellationToken ct)
    {
        var publicBase = $"{Request.Scheme}://{Request.Host}";
        var localBase = LocalBaseUrl();

        try
        {
            var response = await resolveService.ResolveAsync(
                request.ReleaseId,
                request.Client,
                token => $"{publicBase}/api/v1/stream/{token}",
                token => $"{localBase}/api/v1/stream/{token}",
                ct);
            return Ok(response);
        }
        catch (ReleaseNotFoundException e)
        {
            return NotFound(ErrorResponse.Of("release_not_found", e.Message));
        }
        catch (NoPlayableFileException e)
        {
            return UnprocessableEntity(ErrorResponse.Of("no_playable_file", e.Message));
        }
        catch (InvalidDataException e)
        {
            return UnprocessableEntity(ErrorResponse.Of("invalid_release", e.Message));
        }
        catch (UsenetException e)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ErrorResponse.Of("usenet_unreachable", e.Message));
        }
        catch (Exception e) when (e is HttpRequestException or IOException)
        {
            return StatusCode(StatusCodes.Status502BadGateway,
                ErrorResponse.Of("nzb_fetch_failed", e.Message));
        }
    }

    /// <summary>
    /// A loopback-reachable base URL of this server for the in-process ffprobe run.
    /// </summary>
    private string LocalBaseUrl()
    {
        var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses;
        var address = addresses?.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                      ?? addresses?.FirstOrDefault();
        if (string.IsNullOrEmpty(address))
            return $"{Request.Scheme}://{Request.Host}";

        var loopback = address
            .Replace("://+", "://127.0.0.1")
            .Replace("://*", "://127.0.0.1")
            .Replace("0.0.0.0", "127.0.0.1")
            .Replace("[::]", "127.0.0.1");
        return new Uri(loopback).GetLeftPart(UriPartial.Authority);
    }
}
