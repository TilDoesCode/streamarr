using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>
/// GET/HEAD /api/v1/offline/{capability} — the file of one prepared viewer download: Range/206, strong ETag, If-Range, If-Match/If-None-Match,
/// no auth header (the long-lived download capability is the credential, like <c>/stream/{token}</c>), paced below live streams.
/// </summary>
[ApiController]
[ViewerProblemFilter]
public sealed class OfflineFileController(ViewerDownloadFileService files) : ControllerBase
{
    [HttpHead("api/v1/offline/{capability}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status412PreconditionFailed)]
    public async Task<IActionResult> Head(string capability, CancellationToken ct)
        => await files.HeadAsync(HttpContext, capability, ct);

    [HttpGet("api/v1/offline/{capability}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status206PartialContent)]
    [ProducesResponseType(StatusCodes.Status304NotModified)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status409Conflict)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status410Gone)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status412PreconditionFailed)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status416RangeNotSatisfiable)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> Get(string capability, CancellationToken ct)
        => await files.GetAsync(HttpContext, capability, ct);
}
