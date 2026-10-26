using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services.Diagnostics;

namespace Streamarr.Server.Controllers;

/// <summary>Admin diagnostics: full dependency report with names and errors, plus browser-to-server speed test endpoints.</summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/diagnostics")]
public sealed class DiagnosticsController(
    SpeedTestService speed, DiagnosticsService diagnostics, UsenetSpeedTestService usenet, TimeProvider time)
    : SpeedTestControllerBase(speed, diagnostics, time)
{
    protected override string CallerKey => "admin:" + (User.Identity?.Name ?? HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown");

    /// <summary>Overall verdict, hint codes and every checked component with latency and error; <c>refresh=true</c> re-probes once the shared snapshot is at least 10 s old.</summary>
    [HttpGet]
    [EnableRateLimiting(DiagnosticsRateLimits.Report)]
    [ProducesResponseType(typeof(DiagnosticsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<DiagnosticsResponse>> Get([FromQuery] bool refresh = false, CancellationToken ct = default)
        => Ok(await ReportAsync(refresh, redact: false, ct));

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

    /// <summary>The latest server ↔ Usenet speed test (with provider names and error texts) and whether one is running.</summary>
    [HttpGet("usenet-speed")]
    [EnableRateLimiting(DiagnosticsRateLimits.Status)]
    [ProducesResponseType(typeof(UsenetSpeedTestStateResponse), StatusCodes.Status200OK)]
    public ActionResult<UsenetSpeedTestStateResponse> UsenetSpeed()
        => Ok(new UsenetSpeedTestStateResponse
        {
            Running = usenet.Running,
            Allowed = true,
            Latest = usenet.Latest is { } latest ? UsenetSpeedMapping.Response(latest, redact: false) : null,
        });

    /// <summary>
    /// Measures the server's download speed from the primary Usenet provider (the next one when it fails) with connections the pool
    /// has free right now; joins a running test and returns a recent shared result instead of testing again.
    /// <c>503 usenet_speedtest_no_free_connections</c> when the primary has no free connection.
    /// </summary>
    [HttpPost("usenet-speed")]
    [EnableRateLimiting(DiagnosticsRateLimits.Report)]
    [ProducesResponseType(typeof(UsenetSpeedTestResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<UsenetSpeedTestResponse>> RunUsenetSpeed(CancellationToken ct)
    {
        var run = await usenet.RunAsync(CallerKey, limitCaller: false, ct);
        if (run.Result is not { Status: not "busy" } result)
        {
            Response.Headers.RetryAfter = "30";
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new ErrorResponse
            {
                Error = new ErrorDetail
                {
                    Code = "usenet_speedtest_no_free_connections",
                    Message = "The primary provider has no free connection right now; retry when fewer streams are running.",
                    RetryAfterSeconds = 30,
                },
            });
        }
        return Ok(UsenetSpeedMapping.Response(result, redact: false, run.Reused, run.Joined));
    }
}
