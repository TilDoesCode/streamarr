using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Utils;

namespace Streamarr.Usenet.Tests.Utils;

public class InterpolationSearchTests
{
    // 10 segments of uneven sizes; byte ranges are cumulative
    private static readonly long[] Sizes = [500, 700, 300, 900, 100, 650, 820, 430, 999, 601];

    private static LongRange RangeOf(int index)
    {
        long start = 0;
        for (var i = 0; i < index; i++) start += Sizes[i];
        return LongRange.FromStartAndSize(start, Sizes[index]);
    }

    private static long TotalSize => Sizes.Sum();

    [Theory]
    [InlineData(0)]
    [InlineData(499)]
    [InlineData(500)]
    [InlineData(2399)]
    [InlineData(2400)]
    [InlineData(5999)]
    public async Task Find_LocatesTheSegmentContainingTheByte(long searchByte)
    {
        var probes = 0;
        var result = await InterpolationSearch.Find(
            searchByte,
            new LongRange(0, Sizes.Length),
            new LongRange(0, TotalSize),
            guess =>
            {
                probes++;
                return ValueTask.FromResult(RangeOf(guess));
            },
            CancellationToken.None);

        Assert.True(result.FoundByteRange.Contains(searchByte));
        Assert.Equal(RangeOf(result.FoundIndex), result.FoundByteRange);
        Assert.InRange(probes, 1, Sizes.Length);
    }

    [Fact]
    public async Task Find_ByteOutsideRange_Throws()
    {
        await Assert.ThrowsAsync<SeekPositionNotFoundException>(() => InterpolationSearch.Find(
            TotalSize + 5,
            new LongRange(0, Sizes.Length),
            new LongRange(0, TotalSize),
            guess => ValueTask.FromResult(RangeOf(guess)),
            CancellationToken.None));
    }
}
