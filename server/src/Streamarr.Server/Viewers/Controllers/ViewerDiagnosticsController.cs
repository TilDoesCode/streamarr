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
public sealed class ViewerDiagnosticsController(
    SpeedTestService speed,
    DiagnosticsService diagnostics,
    ServiceStatusRefresher serviceStatus,
    UsenetSpeedTestService usenet,
    ViewerAccountService accounts,
    TimeProvider time)
    : SpeedTestControllerBase(speed, diagnostics, time)
{
    protected override string CallerKey => "viewer:" + User.ViewerId();

    /// <summary>Overall verdict, hint codes and every component with status and latency; indexers and providers are numbered ("Indexer 1"), names, hosts and error texts are withheld. <c>refresh=true</c> re-probes once the shared snapshot is at least 10 s old.</summary>
    [HttpGet]
    [EnableRateLimiting(DiagnosticsRateLimits.Report)]
    [ProducesResponseType(typeof(DiagnosticsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<DiagnosticsResponse>> Get([FromQuery] bool refresh = false, CancellationToken ct = default)
        => Ok(await ReportAsync(refresh, redact: true, ct));

    /// <summary>Service status for the app's banner: overall state, affected categories (search, usenet, metadata, server), impact codes, since when, and whether the operator is notified. Served from the background check (every few minutes), never probes per request; no names, hosts or error texts.</summary>
    [HttpGet("status")]
    [EnableRateLimiting(DiagnosticsRateLimits.Status)]
    [ProducesResponseType(typeof(ServiceStatusResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<ServiceStatusResponse>> Status(CancellationToken ct)
        => Ok(await serviceStatus.GetAsync(ct));

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

    /// <summary>The latest server ↔ Usenet speed test, redacted (providers by number and role, codes only), whether one is running and whether this viewer may start one.</summary>
    [HttpGet("usenet-speed")]
    [EnableRateLimiting(DiagnosticsRateLimits.Status)]
    [ProducesResponseType(typeof(UsenetSpeedTestStateResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<UsenetSpeedTestStateResponse>> UsenetSpeed(CancellationToken ct)
    {
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        return Ok(new UsenetSpeedTestStateResponse
        {
            Running = usenet.Running,
            Allowed = viewer.AllowUsenetSpeedTest,
            Latest = usenet.Latest is { } latest ? UsenetSpeedMapping.Response(latest, redact: true) : null,
        });
    }

    /// <summary>
    /// Measures the server's download speed from the primary Usenet provider (the next one when it fails), redacted. One test runs at a
    /// time (callers join it), a recent result is shared instead of testing again, and each viewer may start a few tests per ten minutes.
    /// <c>403 usenet_speedtest_not_allowed</c> without the permission, <c>429 usenet_speedtest_rate_limited</c>,
    /// <c>503 usenet_speedtest_no_free_connections</c> when the primary has no free connection.
    /// </summary>
    [HttpPost("usenet-speed")]
    [EnableRateLimiting(DiagnosticsRateLimits.Report)]
    [ProducesResponseType(typeof(UsenetSpeedTestResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<UsenetSpeedTestResponse>> RunUsenetSpeed(CancellationToken ct)
    {
        var viewer = await accounts.GetAsync(User.ViewerId(), ct);
        if (!viewer.AllowUsenetSpeedTest)
            throw ViewerProblem.Forbidden("usenet_speedtest_not_allowed", "This account may not start a Usenet speed test.");
        var run = await usenet.RunAsync(CallerKey, limitCaller: true, ct);
        if (run.RateLimited)
            throw ViewerProblem.RetryLater(StatusCodes.Status429TooManyRequests, "usenet_speedtest_rate_limited",
                "Too many Usenet speed tests from this account; wait a few minutes.", run.RetryAfter ?? TimeSpan.FromMinutes(1));
        if (run.Result is not { Status: not "busy" } result)
            throw ViewerProblem.RetryLater(StatusCodes.Status503ServiceUnavailable, "usenet_speedtest_no_free_connections",
                "The Usenet provider has no free connection right now; retry when fewer streams are running.", TimeSpan.FromSeconds(30));
        return Ok(UsenetSpeedMapping.Response(result, redact: true, run.Reused, run.Joined));
    }
}
