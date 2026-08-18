using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/pre-downloads")]
public sealed class PreDownloadsController(PreDownloadCoordinator coordinator) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<PreDownloadJobResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<PreDownloadJobResponse>> List([FromQuery] string? sessionToken = null)
    {
        if (sessionToken?.Length > 256 || sessionToken?.Any(char.IsControl) == true)
            return BadRequest(ErrorResponse.Of("invalid_session", "The session token is invalid."));
        return Ok(coordinator.List(sessionToken));
    }
}
