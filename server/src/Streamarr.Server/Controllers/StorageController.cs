using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Controllers;

/// <summary>GET /api/v1/storage — operator storage overview for the Files screen.</summary>
[ApiController]
[Route("api/v1/storage")]
public class StorageController(
    SessionManager sessionManager,
    SegmentCache segmentCache,
    PreDownloadWorkspace preDownloadWorkspace,
    NzbCacheService nzbCache,
    IOptions<StreamarrOptions> options) : ControllerBase
{
    [HttpGet]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(StorageResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<StorageResponse>> Get(CancellationToken ct)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        var o = options.Value;

        var (segmentEntries, segmentBytes) = segmentCache.GetGlobalStats();

        var preDownloadPath = preDownloadWorkspace.Root;
        var (preDownloadFiles, preDownloadBytes) = MeasurePreDownloads(preDownloadPath);
        var (diskTotal, diskFree) = MeasureDisk(preDownloadPath);

        var releases = await nzbCache.ListAsync(ct);
        long nzbBytes = 0;
        foreach (var release in releases)
            nzbBytes += Math.Max(0, release.NzbSizeBytes);

        var sessions = sessionManager.ListSessions();
        long ephemeralBytes = 0;
        foreach (var session in sessions)
            ephemeralBytes += Math.Max(0, session.Session.SizeBytes);

        return Ok(new StorageResponse
        {
            Disk = new StorageDisk
            {
                TotalBytes = diskTotal,
                FreeBytes = diskFree,
                MinimumFreeBytes = o.PreDownload.MinimumFreeDiskBytes,
            },
            SegmentCache = new StorageSegmentCache
            {
                Entries = segmentEntries,
                UsedBytes = segmentBytes,
                CapacityBytes = segmentCache.CapacityBytes,
            },
            PreDownload = new StoragePreDownload
            {
                Path = preDownloadPath,
                FileCount = preDownloadFiles,
                UsedBytes = preDownloadBytes,
            },
            NzbLibrary = new StorageNzbLibrary
            {
                Entries = releases.Count,
                MaxEntries = o.NzbCacheMaxEntries,
                UsedBytes = nzbBytes,
                BudgetBytes = (long)o.NzbCacheSizeMb * 1024 * 1024,
            },
            Ephemeral = new StorageEphemeral
            {
                Files = sessions.Count,
                UsedBytes = ephemeralBytes,
                BudgetBytes = (long)o.EphemeralCacheSizeMb * 1024 * 1024,
            },
        });
    }

    private static (int Files, long Bytes) MeasurePreDownloads(string root)
    {
        try
        {
            if (!Directory.Exists(root))
                return (0, 0);
            var files = 0;
            long bytes = 0;
            foreach (var file in Directory.EnumerateFiles(root))
            {
                if (!file.EndsWith(".cache", StringComparison.Ordinal)
                    && !file.EndsWith(".partial", StringComparison.Ordinal))
                {
                    continue;
                }
                files++;
                try
                {
                    bytes += Math.Max(0, new FileInfo(file).Length);
                }
                catch (IOException)
                {
                    // A file may vanish between enumeration and stat; skip it.
                }
            }
            return (files, bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return (0, 0);
        }
    }

    private static (long? Total, long? Free) MeasureDisk(string root)
    {
        try
        {
            var drive = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root)) ?? "/");
            return (drive.TotalSize, drive.AvailableFreeSpace);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            return (null, null);
        }
    }
}
