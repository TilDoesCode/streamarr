using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>Admin view of viewer device downloads: stored records, live transfers and their speed; revocation.</summary>
[ApiController]
[Route("api/v1/config/viewers/downloads")]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[ViewerProblemFilter]
public sealed class ViewerDownloadsAdminController(ViewerDownloadService downloads) : ControllerBase
{
    /// <summary>Stored downloads (newest first, at most 500), optionally of one viewer or only those transferring right now.</summary>
    [HttpGet]
    [ProducesResponseType(typeof(DownloadAdminListResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<DownloadAdminListResponse>> List([FromQuery] string? viewerId = null, [FromQuery] bool activeOnly = false, CancellationToken ct = default)
        => Ok(await downloads.AdminListAsync(viewerId, activeOnly, ct));

    /// <summary>Revokes a download: its file URL stops working at once and open transfers end.</summary>
    [HttpDelete("{downloadId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string downloadId, CancellationToken ct)
    {
        await downloads.AdminDeleteAsync(downloadId, ct);
        return NoContent();
    }
}
