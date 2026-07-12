using Streamarr.Core.Indexers;

namespace Streamarr.Core.Tests.Indexers;

public class SearchCacheTests
{
    private static IndexerSearchResult ResultWith(int count) => new()
    {
        Releases = Enumerable.Range(0, count).Select(i => new Streamarr.Core.Media.Release
        {
            ReleaseId = i.ToString(),
            Title = $"r{i}",
            Indexer = "x",
            SizeBytes = i,
        }).ToArray(),
        Outcomes = [],
    };

    [Fact]
    public void Set_ThenTryGet_WithinTtl_ReturnsValue()
    {
        var cache = new SearchCache(TimeSpan.FromSeconds(60));
        cache.Set("k", ResultWith(3));

        Assert.True(cache.TryGet("k", out var result));
        Assert.Equal(3, result.Releases.Count);
    }

    [Fact]
    public void TryGet_Miss_ReturnsFalse()
    {
        var cache = new SearchCache(TimeSpan.FromSeconds(60));
        Assert.False(cache.TryGet("absent", out _));
    }

    [Fact]
    public void TryGet_AfterTtl_ReturnsFalseAndEvicts()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 12, 0, 0, 0, TimeSpan.Zero));
        var cache = new SearchCache(TimeSpan.FromSeconds(60), time);
        cache.Set("k", ResultWith(1));

        time.Advance(TimeSpan.FromSeconds(61));

        Assert.False(cache.TryGet("k", out _));
        Assert.Equal(0, cache.Count); // stale entry evicted on read
    }

    [Fact]
    public void Set_WithZeroTtl_NeverStores()
    {
        var cache = new SearchCache(TimeSpan.Zero);
        cache.Set("k", ResultWith(1));
        Assert.False(cache.TryGet("k", out _));
    }
}
