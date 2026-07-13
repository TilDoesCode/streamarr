using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Tests;

public class StoreAndTrackerTests
{
    private static WorkDto Work(string workId, params string[] releaseIds) => new()
    {
        WorkId = workId,
        Title = "W " + workId,
        MediaType = "movie",
        Releases = releaseIds.Select(id => new ReleaseDto
        {
            ReleaseId = id,
            Title = id,
            Indexer = "demo",
            Quality = new QualityDto(),
        }).ToArray(),
    };

    [Fact]
    public void Store_returns_releases_and_finds_by_release_id()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-1", "a", "b"));

        Assert.Equal(2, store.ReleasesFor(itemId).Count);
        Assert.Equal("tmdb-1", store.FindByReleaseId("b")?.Work.WorkId);
        Assert.Null(store.FindByReleaseId("missing"));
    }

    [Fact]
    public void Store_remove_drops_entry()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("tmdb-1", "a"));

        Assert.True(store.Remove(itemId));
        Assert.Empty(store.ReleasesFor(itemId));
    }

    [Fact]
    public void Tracker_round_trips_attribution_and_forgets()
    {
        var tracker = new PlaybackSessionTracker();
        tracker.Track("live-1", "rel-9", "tmdb-9");

        var a = tracker.Resolve("live-1");
        Assert.Equal("rel-9", a?.ReleaseId);
        Assert.Equal("tmdb-9", a?.WorkId);

        tracker.Forget("live-1");
        Assert.Null(tracker.Resolve("live-1"));
        Assert.Null(tracker.Resolve(null));
    }
}
