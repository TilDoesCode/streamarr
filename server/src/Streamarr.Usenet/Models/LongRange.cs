// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Models/LongRange.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (MemoryPack removed).

namespace Streamarr.Usenet.Models;

public record LongRange(long StartInclusive, long EndExclusive)
{
    public long Count => EndExclusive - StartInclusive;

    public bool Contains(long value) =>
        value >= StartInclusive && value < EndExclusive;

    public bool Contains(LongRange range) =>
        range.StartInclusive >= StartInclusive && range.EndExclusive <= EndExclusive;

    public bool IsContainedWithin(LongRange range) =>
        range.Contains(this);

    public static LongRange FromStartAndSize(long startInclusive, long size) =>
        new(startInclusive, startInclusive + size);
}
