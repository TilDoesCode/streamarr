using System.Collections.Concurrent;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Streams;

/// <summary>
/// Process-wide cache of yEnc part metadata (decoded offset/size) per article.
/// Interpolation seeks consult it before probing the wire, so a segment whose
/// header was ever parsed — by a previous seek, a read-ahead download, or another
/// session over the same release — never costs another full-article download.
/// Bounded FIFO: entries are ~250 bytes, so the default cap stays a few tens of MiB.
/// </summary>
public sealed class SegmentMetadataCache(int maxEntries = 200_000)
{
    private readonly ConcurrentDictionary<string, LongRange> _ranges = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _insertionOrder = new();
    private readonly int _maxEntries = maxEntries > 0
        ? maxEntries
        : throw new ArgumentOutOfRangeException(nameof(maxEntries));

    public LongRange? TryGet(string segmentId)
        => _ranges.TryGetValue(SegmentId.Normalize(segmentId), out var range) ? range : null;

    public void Store(string segmentId, long partOffset, long partSize)
    {
        if (partSize <= 0 || partOffset < 0)
            return;

        var key = SegmentId.Normalize(segmentId);
        if (!_ranges.TryAdd(key, new LongRange(partOffset, checked(partOffset + partSize))))
            return;

        _insertionOrder.Enqueue(key);
        while (_ranges.Count > _maxEntries && _insertionOrder.TryDequeue(out var oldest))
            _ranges.TryRemove(oldest, out _);
    }
}
