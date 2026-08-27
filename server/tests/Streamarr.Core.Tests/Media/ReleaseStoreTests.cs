using Streamarr.Core.Media;

namespace Streamarr.Core.Tests.Media;

public sealed class ReleaseStoreTests
{
    [Fact]
    public void FindUsableFiltersUnavailableReleasesAndUsesStableRankingOrder()
    {
        var health = new ReleaseHealthCache(TimeSpan.FromMinutes(30));
        var store = new InMemoryReleaseStore(health);
        store.Register("work", Release("z", "Zulu", 100));
        store.Register("work", Release("b", "Beta", 200));
        store.Register("work", Release("a", "alpha", 200));
        store.Register("work", Release("dead-field", "Aardvark", 1_000, health: ReleaseHealth.Dead));
        store.Register("work", Release("rejected", "Aardvark", 999, rejected: true));
        store.Register("work", Release("dead-cache", "Aardvark", 998));
        store.Register("other-work", Release("other", "Aardvark", 2_000));
        health.Record("dead-cache", ReleaseHealth.Dead);

        var usable = store.FindUsable("work");

        Assert.Equal(["a", "b", "z"], usable.Select(item => item.Release.ReleaseId));
        Assert.Equal("a", store.FindBest("work")!.Release.ReleaseId);
        Assert.Equal("b", store.FindFallback("work", "a")!.Release.ReleaseId);
    }

    [Fact]
    public void ReleaseIdBreaksOtherwiseIdenticalTies()
    {
        var store = new InMemoryReleaseStore();
        store.Register("work", Release("release-b", "Same.Title", 100));
        store.Register("work", Release("release-a", "Same.Title", 100));

        Assert.Equal(
            ["release-a", "release-b"],
            store.FindUsable("work").Select(item => item.Release.ReleaseId));
    }

    private static Release Release(
        string id,
        string title,
        int score,
        bool rejected = false,
        ReleaseHealth health = ReleaseHealth.Unknown)
        => new()
        {
            ReleaseId = id,
            Title = title,
            Indexer = "test",
            SizeBytes = 1_000,
            Score = score,
            Rejected = rejected,
            Health = health,
        };
}
