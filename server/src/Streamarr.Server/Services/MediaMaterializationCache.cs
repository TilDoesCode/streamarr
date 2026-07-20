using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// Bounded process-local cache for immutable direct-file size probes and RAR slice maps.
/// The fingerprint covers the complete selected NZB payload, so a changed NZB cannot
/// reuse stale materialization data. Failed and cancelled materializations are not cached.
/// </summary>
public sealed class MediaMaterializationCache(IOptions<StreamarrOptions> options)
{
    private const long CacheBookkeepingBytesPerEntry = 1024;

    private readonly ConcurrentDictionary<string, CacheEntry> _entries =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates =
        new(StringComparer.Ordinal);
    private readonly Queue<string> _insertionOrder = new();
    private readonly object _cacheGate = new();
    private long _totalWeightBytes;

    private sealed record CacheEntry(ResolvedMediaFile File, long WeightBytes);

    public async Task<ResolvedMediaFile> GetOrCreateAsync(
        string releaseId,
        MediaFileCandidate candidate,
        Func<CancellationToken, Task<ResolvedMediaFile>> materialize,
        CancellationToken ct)
    {
        var maxEntries = options.Value.MediaMaterializationCacheMaxEntries;
        var maxWeightBytes = (long)options.Value.MediaMaterializationCacheSizeMb * 1024 * 1024;
        if (maxEntries == 0 || maxWeightBytes == 0)
            return await materialize(ct);

        var key = ComputeKey(releaseId, candidate);
        if (_entries.TryGetValue(key, out var cached))
            return cached.File;

        var gate = _gates.GetOrAdd(key, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (_entries.TryGetValue(key, out cached))
                return cached.File;

            var resolved = await materialize(ct);
            var weightBytes = EstimateEntryWeightBytes(key, resolved);
            if (weightBytes <= maxWeightBytes)
                AddAndTrim(key, resolved, weightBytes, maxEntries, maxWeightBytes);

            return resolved;
        }
        finally
        {
            gate.Release();
            if (gate.CurrentCount == 1)
                _gates.TryRemove(new KeyValuePair<string, SemaphoreSlim>(key, gate));
        }
    }

    private void AddAndTrim(
        string key,
        ResolvedMediaFile resolved,
        long weightBytes,
        int maxEntries,
        long maxWeightBytes)
    {
        lock (_cacheGate)
        {
            if (_entries.ContainsKey(key))
                return;

            // Evict before insertion so the cache-owned graph never transiently exceeds
            // either configured bound. Hits do not change order: this is intentionally FIFO.
            while (_entries.Count >= maxEntries || _totalWeightBytes > maxWeightBytes - weightBytes)
            {
                if (!TryEvictOldest())
                    return;
            }

            if (!_entries.TryAdd(key, new CacheEntry(resolved, weightBytes)))
                return;

            _insertionOrder.Enqueue(key);
            _totalWeightBytes += weightBytes;
        }
    }

    private bool TryEvictOldest()
    {
        while (_insertionOrder.TryDequeue(out var oldest))
        {
            if (!_entries.TryRemove(oldest, out var removed))
                continue;

            _totalWeightBytes -= removed.WeightBytes;
            return true;
        }

        return false;
    }

    private static long EstimateEntryWeightBytes(string key, ResolvedMediaFile resolved)
    {
        // Custom/legacy materializers may not populate the richer estimate. Always derive
        // a floor from the public result so message-id strings and their array are counted.
        var minimumResultWeight = MediaFileMaterializer.EstimateCacheWeightBytes(
            resolved.FileName,
            resolved.Container,
            [resolved.SegmentIds],
            hasFlattenedSegmentArray: false,
            rarSliceCount: 0);
        var resultWeight = Math.Max(minimumResultWeight, resolved.EstimatedCacheWeightBytes);
        var keyAndBookkeeping = CacheBookkeepingBytesPerEntry + 24L + (key.Length + 1L) * sizeof(char);
        return resultWeight >= long.MaxValue - keyAndBookkeeping
            ? long.MaxValue
            : resultWeight + keyAndBookkeeping;
    }

    internal static string ComputeKey(string releaseId, MediaFileCandidate candidate)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(releaseId);
        Append(candidate.DisplayName);
        Append(candidate.IsRarWrapped ? "rar" : "direct");
        Append(candidate.Files.Count.ToString(CultureInfo.InvariantCulture));

        foreach (var file in candidate.Files)
        {
            Append(file.Subject);
            Append(file.Segments.Count.ToString(CultureInfo.InvariantCulture));
            foreach (var segment in file.Segments)
            {
                Append(segment.Number.ToString(CultureInfo.InvariantCulture));
                Append(segment.Bytes.ToString(CultureInfo.InvariantCulture));
                Append(segment.MessageId);
            }
        }

        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();

        void Append(string value)
        {
            hash.AppendData(Encoding.UTF8.GetBytes(value));
            hash.AppendData([0]);
        }
    }
}
