using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>
/// Retires the file capabilities a security sign-out covers, inside the sign-out's own transaction: ready downloads lose their URL
/// (it answers 410 <c>download_revoked</c>), preparing ones are marked so they publish without one. Only downloads bound to the ended
/// sessions are touched (<see cref="ViewerSessionRevocation.Covers"/>), so an ordinary logout or another device keeps its URLs.
/// </summary>
internal static class DownloadCapabilityRetirement
{
    /// <returns>The ready downloads whose file URL was retired (their open transfers end next).</returns>
    public static async Task<IReadOnlyList<string>> RetireAsync(StreamarrDbContext db, ViewerSessionRevocation revocation, DateTimeOffset now, CancellationToken ct)
    {
        var revokedAt = (DateTimeOffset?)now;
        var ready = await Covered(db, revocation)
            .Where(d => d.State == ViewerDownloadService.States.Ready && d.CapabilityHash != null)
            .Select(d => d.Id)
            .ToListAsync(ct);
        if (ready.Count > 0)
        {
            await db.ViewerDownloads.Where(d => ready.Contains(d.Id)).ExecuteUpdateAsync(s => s
                .SetProperty(d => d.RevokedCapabilityHash, d => d.CapabilityHash)
                .SetProperty(d => d.CapabilityHash, (string?)null)
                .SetProperty(d => d.CapabilityProtected, (string?)null)
                .SetProperty(d => d.CapabilityRevokedAt, revokedAt)
                .SetProperty(d => d.Revision, d => d.Revision + 1)
                .SetProperty(d => d.UpdatedAt, now), ct);
        }
        await Covered(db, revocation)
            .Where(d => (d.State == ViewerDownloadService.States.Queued || d.State == ViewerDownloadService.States.Resolving
                         || d.State == ViewerDownloadService.States.Probing) && d.CapabilityRevokedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(d => d.CapabilityRevokedAt, revokedAt)
                .SetProperty(d => d.Revision, d => d.Revision + 1)
                .SetProperty(d => d.UpdatedAt, now), ct);
        return ready;
    }

    private static IQueryable<ViewerDownloadEntity> Covered(StreamarrDbContext db, ViewerSessionRevocation revocation)
    {
        var downloads = db.ViewerDownloads.Where(d => d.ViewerId == revocation.ViewerId);
        if (revocation.OnlySessionId is { } only)
            return downloads.Where(d => d.SessionId == only);
        return revocation.KeepSessionId is { } keep ? downloads.Where(d => d.SessionId != keep) : downloads;
    }
}
