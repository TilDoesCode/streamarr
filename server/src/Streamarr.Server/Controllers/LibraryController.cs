using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>Admin library of releases backed by Core's persistent NZB cache.</summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/library/releases")]
public sealed class LibraryController(NzbCacheService cache) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<CachedReleaseResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<CachedReleaseResponse>>> List(CancellationToken ct)
        => Ok((await cache.ListAsync(ct)).Select(ToResponse).ToList());

    [HttpDelete("{releaseId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Remove(string releaseId, CancellationToken ct)
        => await cache.RemoveAsync(releaseId, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("cached_release_not_found", "The cached release does not exist."));

    private static CachedReleaseResponse ToResponse(CachedReleaseEntity entry) => new()
    {
        ReleaseId = entry.ReleaseId,
        WorkId = entry.WorkId,
        Title = entry.Title,
        Indexer = entry.Indexer,
        ReleaseSizeBytes = entry.ReleaseSizeBytes,
        NzbSizeBytes = entry.NzbSizeBytes,
        FileCount = entry.FileCount,
        SegmentCount = entry.SegmentCount,
        HitCount = entry.HitCount,
        CachedAt = entry.CachedAt,
        LastAccessedAt = entry.LastAccessedAt,
    };
}
