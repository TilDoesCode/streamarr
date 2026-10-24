using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>Shared speed test and diagnostics actions for the admin and viewer controllers.</summary>
public abstract class SpeedTestControllerBase(SpeedTestService speed, DiagnosticsService diagnostics, TimeProvider time) : ControllerBase
{
    /// <summary>Request paths whose bodies may exceed the global 1 MiB API limit.</summary>
    public static readonly string[] UploadPaths = ["/api/v1/diagnostics/speed/upload", "/api/v1/viewer/diagnostics/speed/upload"];

    /// <summary>Concurrency key of the signed-in caller.</summary>
    protected abstract string CallerKey { get; }

    protected Task<DiagnosticsResponse> ReportAsync(bool refresh, bool redact, CancellationToken ct)
        => diagnostics.BuildAsync(refresh, redact, ct);

    protected SpeedTestPingResponse PingResult() => speed.Ping(time.GetUtcNow());

    protected async Task<IActionResult> DownloadResult(long? bytes, CancellationToken ct)
    {
        var size = bytes ?? SpeedTestService.DefaultDownloadBytes;
        if (size is < 1 or > SpeedTestService.MaxDownloadBytes)
        {
            return BadRequest(ErrorResponse.Of("invalid_size",
                $"'bytes' must be between 1 and {SpeedTestService.MaxDownloadBytes}."));
        }

        using var lease = speed.TryAcquire(CallerKey);
        if (lease is null)
            return Busy();
        await speed.WriteDownloadAsync(HttpContext, size, ct);
        return new EmptyResult();
    }

    protected async Task<IActionResult> UploadResult(CancellationToken ct)
    {
        if (Request.ContentLength is > SpeedTestService.MaxUploadBytes)
            return TooLarge();

        using var lease = speed.TryAcquire(CallerKey);
        if (lease is null)
            return Busy();
        try
        {
            return Ok(await speed.DrainUploadAsync(Request.Body, ct));
        }
        catch (InvalidDataException)
        {
            return TooLarge();
        }
        catch (BadHttpRequestException e) when (e.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return TooLarge();
        }
    }

    private ObjectResult Busy()
    {
        Response.Headers.RetryAfter = "2";
        return StatusCode(StatusCodes.Status429TooManyRequests, new ErrorResponse
        {
            Error = new ErrorDetail
            {
                Code = "speedtest_busy",
                Message = "Too many speed test transfers are running; retry shortly.",
                RetryAfterSeconds = 2,
            },
        });
    }

    private ObjectResult TooLarge() => StatusCode(StatusCodes.Status413PayloadTooLarge,
        ErrorResponse.Of("payload_too_large", $"Speed test uploads are limited to {SpeedTestService.MaxUploadBytes} bytes."));
}
