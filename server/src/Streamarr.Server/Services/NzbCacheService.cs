using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Services;

public sealed record NzbCacheDescriptor(
    string ReleaseId,
    string WorkId,
    string Title,
    string Indexer,
    long ReleaseSizeBytes);

public sealed record CachedNzb(NzbDocument Document, bool CacheHit);

/// <summary>
/// Persistent, bounded NZB cache owned by Core. Source URLs (which commonly contain API keys)
/// are never persisted; cache files use a SHA-256 name and metadata lives in SQLite.
/// </summary>
public sealed class NzbCacheService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    IOptions<StreamarrOptions> options,
    IHostEnvironment environment,
    TimeProvider time,
    ILogger<NzbCacheService> logger)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _releaseGates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _mutationGate = new(1, 1);

    private string CacheDirectory
    {
        get
        {
            var configured = options.Value.NzbCachePath;
            return string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(environment.ContentRootPath, "cache", "nzb")
                : Path.GetFullPath(configured, environment.ContentRootPath);
        }
    }

    public async Task<CachedNzb> GetOrCreateAsync(
        NzbCacheDescriptor descriptor,
        Func<CancellationToken, Task<byte[]>> fetch,
        CancellationToken ct)
    {
        var gate = _releaseGates.GetOrAdd(descriptor.ReleaseId, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var cached = await TryReadAsync(descriptor.ReleaseId, ct);
            if (cached is not null)
                return new CachedNzb(cached, true);

            var bytes = await fetch(ct);
            var document = await ParseAsync(bytes, ct);
            await StoreAsync(descriptor, bytes, document, ct);
            return new CachedNzb(document, false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<IReadOnlyList<CachedReleaseEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entries = await db.CachedReleases.AsNoTracking().ToListAsync(ct);
        return entries.OrderByDescending(entry => entry.LastAccessedAt).ToList();
    }

    public async Task<bool> RemoveAsync(string releaseId, CancellationToken ct)
    {
        await _mutationGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await db.CachedReleases.FindAsync([releaseId], ct);
            if (entity is null)
                return false;
            db.CachedReleases.Remove(entity);
            await db.SaveChangesAsync(ct);
            DeleteFile(entity.CacheFileName);
            return true;
        }
        finally
        {
            _mutationGate.Release();
        }
    }

    private async Task<NzbDocument?> TryReadAsync(string releaseId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await db.CachedReleases.SingleOrDefaultAsync(entry => entry.ReleaseId == releaseId, ct);
        if (entity is null)
            return null;

        var path = CachePath(entity.CacheFileName);
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != entity.NzbSizeBytes || info.Length > options.Value.MaxNzbBytes)
                throw new InvalidDataException("Cached NZB file metadata no longer matches its source file.");

            var bytes = await File.ReadAllBytesAsync(path, ct);
            var document = await ParseAsync(bytes, ct);
            entity.HitCount++;
            entity.LastAccessedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
            return document;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            logger.LogWarning(exception, "Discarding unreadable NZB cache entry {ReleaseId}", releaseId);
            db.CachedReleases.Remove(entity);
            await db.SaveChangesAsync(ct);
            DeleteFile(entity.CacheFileName);
            return null;
        }
    }

    private async Task StoreAsync(
        NzbCacheDescriptor descriptor,
        byte[] bytes,
        NzbDocument document,
        CancellationToken ct)
    {
        await _mutationGate.WaitAsync(ct);
        try
        {
            var maxBytes = checked((long)options.Value.NzbCacheSizeMb * 1024 * 1024);
            if (bytes.LongLength > maxBytes)
            {
                logger.LogInformation(
                    "NZB for release {ReleaseId} is larger than the configured cache budget and will not be persisted",
                    descriptor.ReleaseId);
                return;
            }

            Directory.CreateDirectory(CacheDirectory);
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await PruneForAsync(db, bytes.LongLength, descriptor.ReleaseId, ct);

            var fileName = $"{Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(descriptor.ReleaseId))).ToLowerInvariant()}.nzb";
            var finalPath = CachePath(fileName);
            var temporaryPath = finalPath + $".{Guid.NewGuid():N}.tmp";
            try
            {
                await File.WriteAllBytesAsync(temporaryPath, bytes, ct);
                File.Move(temporaryPath, finalPath, overwrite: true);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
            }

            var now = time.GetUtcNow();
            var existing = await db.CachedReleases.FindAsync([descriptor.ReleaseId], ct);
            var entity = existing ?? new CachedReleaseEntity { ReleaseId = descriptor.ReleaseId, CachedAt = now };
            entity.WorkId = descriptor.WorkId;
            entity.Title = descriptor.Title;
            entity.Indexer = descriptor.Indexer;
            entity.ReleaseSizeBytes = descriptor.ReleaseSizeBytes;
            entity.CacheFileName = fileName;
            entity.NzbSizeBytes = bytes.LongLength;
            entity.FileCount = document.Files.Count;
            entity.SegmentCount = document.Files.Sum(file => file.Segments.Count);
            entity.LastAccessedAt = now;
            if (existing is null)
                db.CachedReleases.Add(entity);
            await db.SaveChangesAsync(ct);
        }
        finally
        {
            _mutationGate.Release();
        }
    }

    private async Task PruneForAsync(StreamarrDbContext db, long incomingBytes, string incomingReleaseId, CancellationToken ct)
    {
        var maxBytes = checked((long)options.Value.NzbCacheSizeMb * 1024 * 1024);
        var entries = await db.CachedReleases
            .Where(entry => entry.ReleaseId != incomingReleaseId)
            .ToListAsync(ct);
        entries = entries.OrderBy(entry => entry.LastAccessedAt).ToList();
        var total = entries.Sum(entry => entry.NzbSizeBytes);
        var maxEntries = Math.Max(1, options.Value.NzbCacheMaxEntries);
        var remainingCount = entries.Count;

        foreach (var victim in entries)
        {
            if (total + incomingBytes <= maxBytes && remainingCount < maxEntries)
                break;
            total -= victim.NzbSizeBytes;
            remainingCount--;
            db.CachedReleases.Remove(victim);
            DeleteFile(victim.CacheFileName);
        }
        await db.SaveChangesAsync(ct);
    }

    private async Task<NzbDocument> ParseAsync(byte[] bytes, CancellationToken ct)
    {
        await using var stream = new MemoryStream(bytes, writable: false);
        return await NzbDocument.LoadAsync(stream, ct, new NzbDocumentLimits
        {
            MaxFiles = options.Value.MaxNzbFiles,
            MaxSegments = options.Value.MaxNzbSegments,
            MaxSegmentsPerFile = options.Value.MaxNzbSegments,
        });
    }

    private string CachePath(string fileName)
    {
        if (Path.GetFileName(fileName) != fileName)
            throw new InvalidDataException("Invalid NZB cache file name.");
        return Path.Combine(CacheDirectory, fileName);
    }

    private void DeleteFile(string fileName)
    {
        try
        {
            var path = CachePath(fileName);
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            logger.LogWarning(exception, "Could not remove NZB cache file {FileName}", fileName);
        }
    }
}
