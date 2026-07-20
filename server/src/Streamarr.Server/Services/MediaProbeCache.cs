using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Services;

/// <summary>
/// Persistent media-info cache tied to the bounded NZB cache row for a release.
/// The key includes the materialized file identity and every article id, so a changed
/// NZB can never reuse stale probe metadata.
/// </summary>
public sealed class MediaProbeCache(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    TimeProvider time,
    ILogger<MediaProbeCache> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly KeyedAsyncLock _gates = new();

    public async Task<FfprobeResult?> GetOrCreateAsync(
        string releaseId,
        ResolvedMediaFile media,
        Func<CancellationToken, Task<FfprobeResult?>> probe,
        CancellationToken ct)
    {
        var probeKey = ComputeKey(releaseId, media);
        var gateKey = string.Concat(releaseId, ":", probeKey);
        using var lease = await _gates.AcquireAsync(gateKey, ct);
        var cached = await TryReadAsync(releaseId, probeKey, ct);
        if (cached is not null)
            return cached;

        var result = await probe(ct);
        if (result is not null && IsCacheable(result))
            await StoreAsync(releaseId, probeKey, result, ct);
        return result;
    }

    internal static bool IsCacheable(FfprobeResult result)
        => result.RunTimeTicks is > 0 || result.MediaStreams.Count > 0;

    internal async Task<FfprobeResult?> TryReadAsync(
        string releaseId,
        string probeKey,
        CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entry = await db.CachedReleases
            .AsNoTracking()
            .Where(candidate => candidate.ReleaseId == releaseId)
            .Select(candidate => new { candidate.MediaProbeKey, candidate.MediaProbeJson })
            .SingleOrDefaultAsync(ct);
        if (entry?.MediaProbeKey != probeKey || string.IsNullOrWhiteSpace(entry.MediaProbeJson))
            return null;

        try
        {
            return JsonSerializer.Deserialize<FfprobeResult>(entry.MediaProbeJson, JsonOptions);
        }
        catch (JsonException exception)
        {
            logger.LogWarning(exception, "Ignoring invalid cached media probe metadata for release {ReleaseId}", releaseId);
            return null;
        }
    }

    private async Task StoreAsync(
        string releaseId,
        string probeKey,
        FfprobeResult result,
        CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entry = await db.CachedReleases.SingleOrDefaultAsync(candidate => candidate.ReleaseId == releaseId, ct);
        if (entry is null)
        {
            logger.LogDebug("Skipping media probe persistence because release {ReleaseId} is not in the NZB cache", releaseId);
            return;
        }

        entry.MediaProbeKey = probeKey;
        entry.MediaProbeJson = JsonSerializer.Serialize(result, JsonOptions);
        entry.MediaProbeCachedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
    }

    internal static string ComputeKey(string releaseId, ResolvedMediaFile media)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(releaseId);
        Append(media.FileName);
        Append(media.Container);
        Append(media.SizeBytes.ToString(CultureInfo.InvariantCulture));
        Append(media.SegmentIds.Count.ToString(CultureInfo.InvariantCulture));
        foreach (var segmentId in media.SegmentIds)
            Append(segmentId);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();

        void Append(string value)
        {
            hash.AppendData(Encoding.UTF8.GetBytes(value));
            hash.AppendData([0]);
        }
    }
}
