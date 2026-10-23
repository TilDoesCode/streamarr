using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Connection check for viewer apps: a redacted server diagnostics report and speed test endpoints.</summary>
[ApiController]
[Route("api/v1/viewer/diagnostics")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
[ViewerModelStateFilter]
public sealed class ViewerDiagnosticsController(SpeedTestService speed, DiagnosticsService diagnostics, TimeProvider time)
    : SpeedTestControllerBase(speed, diagnostics, time)
{
    protected override string CallerKey => "viewer:" + User.ViewerId();

    /// <summary>Overall verdict, hint codes and every component with status and latency; indexers and providers are numbered ("Indexer 1"), names, hosts and error texts are withheld. <c>refresh=true</c> re-probes once the shared snapshot is at least 10 s old.</summary>
    [HttpGet]
    [EnableRateLimiting(DiagnosticsRateLimits.Report)]
    [ProducesResponseType(typeof(DiagnosticsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<DiagnosticsResponse>> Get([FromQuery] bool refresh = false, CancellationToken ct = default)
        => Ok(await ReportAsync(refresh, redact: true, ct));

    /// <summary>Speed test round trip: a tiny answer with the server time and the transfer limits.</summary>
    [HttpGet("ping")]
    [EnableRateLimiting(DiagnosticsRateLimits.SpeedTest)]
    [ProducesResponseType(typeof(SpeedTestPingResponse), StatusCodes.Status200OK)]
    public ActionResult<SpeedTestPingResponse> Ping() => Ok(PingResult());

    /// <summary>Streams <c>bytes</c> (default 10 MiB, at most 2 GiB) of incompressible random data; clients keep one request per stream open and disconnect when their time is up.</summary>
    [HttpGet("speed/download")]
    [EnableRateLimiting(DiagnosticsRateLimits.SpeedTest)]
    [ProducesResponseType(typeof(FileResult), StatusCodes.Status200OK, "application/octet-stream")]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest, "application/json")]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests, "application/json")]
    public Task<IActionResult> Download([FromQuery] long? bytes, CancellationToken ct) => DownloadResult(bytes, ct);

    /// <summary>Reads and discards an <c>application/octet-stream</c> body of at most 100 MiB and reports its size and the server-side read time.</summary>
    [HttpPost("speed/upload")]
    [OctetStreamBody]
    [RequestSizeLimit(SpeedTestService.MaxUploadBytes)]
    [EnableRateLimiting(DiagnosticsRateLimits.SpeedTest)]
    [ProducesResponseType(typeof(SpeedTestUploadResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status413PayloadTooLarge)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public Task<IActionResult> Upload(CancellationToken ct) => UploadResult(ct);
}
