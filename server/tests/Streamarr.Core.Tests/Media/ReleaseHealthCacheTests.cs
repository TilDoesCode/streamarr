using Streamarr.Core.Media;
using Streamarr.Core.Tests.Indexers;

namespace Streamarr.Core.Tests.Media;

public class ReleaseHealthCacheTests
{
    [Fact]
    public void RecordsAndReadsBackClassification()
    {
        var cache = new ReleaseHealthCache(TimeSpan.FromMinutes(30));
        cache.Record("rel-1", ReleaseHealth.Dead);

        Assert.Equal(ReleaseHealth.Dead, cache.Get("rel-1"));
        Assert.True(cache.IsDead("rel-1"));
        Assert.Null(cache.Get("rel-2"));
        Assert.False(cache.IsDead("rel-2"));
    }

    [Fact]
    public void ExpiresAfterTtl()
    {
        var time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 12, 0, 0, 0, TimeSpan.Zero));
        var cache = new ReleaseHealthCache(TimeSpan.FromMinutes(10), time);
        cache.Record("rel-1", ReleaseHealth.Dead);

        time.Advance(TimeSpan.FromMinutes(9));
        Assert.True(cache.IsDead("rel-1"));

        time.Advance(TimeSpan.FromMinutes(2));
        Assert.False(cache.IsDead("rel-1"));
        Assert.Null(cache.Get("rel-1"));
    }

    [Fact]
    public void ZeroTtlDisablesCache()
    {
        var cache = new ReleaseHealthCache(TimeSpan.Zero);
        cache.Record("rel-1", ReleaseHealth.Dead);
        Assert.Null(cache.Get("rel-1"));
    }
}

public class FindFallbackTests
{
    private static Release Rel(string id, int score, bool rejected = false, ReleaseHealth health = ReleaseHealth.Unknown) => new()
    {
        ReleaseId = id,
        Title = id,
        Indexer = "mock",
        SizeBytes = 1000,
        Score = score,
        Rejected = rejected,
        Health = health,
    };

    [Fact]
    public void PicksHighestScoringHealthySibling()
    {
        var store = new InMemoryReleaseStore();
        store.Register("work-1", Rel("a", 900));
        store.Register("work-1", Rel("b", 850));
        store.Register("work-1", Rel("c", 800));

        var fallback = store.FindFallback("work-1", excludeReleaseId: "a");
        Assert.Equal("b", fallback!.Release.ReleaseId);
    }

    [Fact]
    public void SkipsReleasesCachedDead()
    {
        var cache = new ReleaseHealthCache(TimeSpan.FromMinutes(30));
        var store = new InMemoryReleaseStore(cache);
        store.Register("work-1", Rel("a", 900));
        store.Register("work-1", Rel("b", 850)); // best sibling …
        store.Register("work-1", Rel("c", 800));

        cache.Record("b", ReleaseHealth.Dead); // … but a prior resolve found it dead

        var fallback = store.FindFallback("work-1", excludeReleaseId: "a");
        Assert.Equal("c", fallback!.Release.ReleaseId);
    }

    [Fact]
    public void ReturnsNullWhenNoHealthySiblingRemains()
    {
        var cache = new ReleaseHealthCache(TimeSpan.FromMinutes(30));
        var store = new InMemoryReleaseStore(cache);
        store.Register("work-1", Rel("a", 900));
        store.Register("work-1", Rel("b", 850));
        cache.Record("b", ReleaseHealth.Dead);

        Assert.Null(store.FindFallback("work-1", excludeReleaseId: "a"));
    }
}
