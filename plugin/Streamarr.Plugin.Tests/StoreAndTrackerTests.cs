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
    public void Store_persists_release_state_across_restart_and_persists_removal()
    {
        var directory = Path.Combine(Path.GetTempPath(), "streamarr-plugin-tests", Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "ephemeral-releases.json");
        try
        {
            var itemId = Guid.NewGuid();
            var first = new EphemeralReleaseStore(path);
            first.Put(itemId, Work("tmdb-1", "a", "b"));

            var restored = new EphemeralReleaseStore(path);
            Assert.Equal(["a", "b"], restored.ReleasesFor(itemId).Select(r => r.ReleaseId));
            Assert.True(restored.Remove(itemId));

            var afterRemoval = new EphemeralReleaseStore(path);
            Assert.Empty(afterRemoval.ReleasesFor(itemId));
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Store_has_a_hard_entry_limit_and_evicts_oldest()
    {
        var store = new EphemeralReleaseStore();
        var first = Guid.NewGuid();
        store.Put(first, Work("first", "r-first"));
        for (var index = 1; index <= EphemeralReleaseStore.MaxEntries; index++)
            store.Put(Guid.NewGuid(), Work("work-" + index, "release-" + index));

        Assert.Equal(EphemeralReleaseStore.MaxEntries, store.All().Count);
        Assert.Null(store.Peek(first));
    }

    [Fact]
    public void Store_bounds_nested_releases_before_holding_or_persisting_them()
    {
        var store = new EphemeralReleaseStore();
        var releases = Enumerable.Range(0, StreamarrPayloadBounds.MaxReleasesPerWork + 10)
            .Select(index => "release-" + index)
            .ToArray();

        var itemId = Guid.NewGuid();
        store.Put(itemId, Work("bounded-work", releases));

        Assert.Equal(StreamarrPayloadBounds.MaxReleasesPerWork, store.ReleasesFor(itemId).Count);
    }

    [Fact]
    public void Store_rejects_oversized_persistence_file_before_json_deserialization()
    {
        var directory = Path.Combine(Path.GetTempPath(), "streamarr-plugin-tests", Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "ephemeral-releases.json");
        try
        {
            Directory.CreateDirectory(directory);
            using (var file = File.Create(path))
                file.SetLength(EphemeralReleaseStore.MaxPersistenceFileBytes + 1L);

            var restored = new EphemeralReleaseStore(path);

            Assert.Empty(restored.All());
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Tracker_round_trips_attribution_and_forgets()
    {
        var tracker = new PlaybackSessionTracker();
        tracker.TrackSession(Guid.NewGuid(), "live-1", "rel-9", "tmdb-9", "session-9");

        var a = tracker.Resolve("live-1");
        Assert.Equal("rel-9", a?.ReleaseId);
        Assert.Equal("tmdb-9", a?.WorkId);

        tracker.Forget("live-1");
        Assert.Null(tracker.Resolve("live-1"));
        Assert.Null(tracker.Resolve(null));
    }

    [Fact]
    public void Tracker_removes_every_alias_and_can_take_sessions_for_cleanup()
    {
        var tracker = new PlaybackSessionTracker();
        var itemId = Guid.NewGuid();
        tracker.TrackSession(itemId, "live-1", "rel-9", "tmdb-9", "session-9", "alias-9");

        Assert.NotNull(tracker.Resolve("rel-9"));
        Assert.NotNull(tracker.Resolve("alias-9"));
        Assert.Single(tracker.TakeForItem(itemId));
        Assert.Null(tracker.Resolve("live-1"));
        Assert.Null(tracker.Resolve("rel-9"));
        Assert.Null(tracker.Resolve("alias-9"));
        Assert.Empty(tracker.All());
    }

    [Fact]
    public void Tracker_rejects_over_limit_session_without_evicting_existing_attribution()
    {
        var tracker = new PlaybackSessionTracker();
        for (var index = 0; index < 512; index++)
        {
            Assert.True(tracker.TryTrackSession(
                Guid.NewGuid(),
                "live-" + index,
                "release-" + index,
                null,
                "session-" + index,
                out _));
        }

        Assert.False(tracker.TryTrackSession(
            Guid.NewGuid(), "overflow-live", "overflow-release", null, "overflow-session", out _));
        Assert.Equal(512, tracker.All().Count);
        Assert.NotNull(tracker.Resolve("live-0"));
    }
}
