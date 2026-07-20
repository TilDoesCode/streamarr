using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Tests;

public class MediaSourceOfferStoreTests
{
    [Fact]
    public void Offer_is_opaque_replayable_and_bound_to_the_authenticated_user()
    {
        var store = new MediaSourceOfferStore();
        var itemId = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var otherUser = Guid.NewGuid();
        var created = store.CreateOffers(itemId, owner, "work-a", ["release-a", "release-b"]);
        var token = created["release-a"];

        Assert.NotEqual("release-a", token);
        Assert.False(store.TryAcquire(token, otherUser, out _));
        Assert.True(store.TryAcquire(token, owner, out var firstLease));
        var offer = firstLease!.Offer;
        Assert.Equal(itemId, offer.ItemId);
        Assert.Equal("work-a", offer.WorkId);
        Assert.Equal("release-a", offer.ReleaseId);
        Assert.Contains("release-b", offer.AllowedReleaseIds);

        // Jellyfin clients may cache a projected MediaSource and reuse its OpenToken when the
        // same episode is stopped and immediately replayed. The short-lived, user-bound offer
        // must remain valid for that retry instead of surfacing a host-side HTTP 500.
        Assert.True(store.TryAcquire(token, owner, out var replayLease));
        Assert.Equal(offer, replayLease!.Offer);
        replayLease.Dispose();
        firstLease.Dispose();
    }

    [Fact]
    public void Unknown_or_cross_work_release_cannot_be_opened_by_an_offer()
    {
        var store = new MediaSourceOfferStore();
        var userId = Guid.NewGuid();
        var created = store.CreateOffers(Guid.NewGuid(), userId, "work-a", ["release-a"]);

        Assert.False(store.TryAcquire("release-a", userId, out _));
        Assert.True(store.TryAcquire(created["release-a"], userId, out var lease));
        Assert.DoesNotContain("release-from-work-b", lease!.Offer.AllowedReleaseIds);
        lease.Dispose();
    }

    [Fact]
    public void Equivalent_playback_info_requests_reuse_the_same_bounded_offer()
    {
        var store = new MediaSourceOfferStore();
        var itemId = Guid.NewGuid();
        var userId = Guid.NewGuid();
        var first = store.CreateOffers(itemId, userId, "work-a", ["release-a"])["release-a"];
        var second = store.CreateOffers(itemId, userId, "work-a", ["release-a"])["release-a"];

        Assert.Equal(first, second);
        Assert.True(store.TryAcquire(first, userId, out var firstLease));
        Assert.True(store.TryAcquire(second, userId, out var secondLease));
        firstLease!.Dispose();
        secondLease!.Dispose();
    }

    [Fact]
    public void ActiveOffer_DoesNotExpireDuringLongPlayback_AndReplayTtlStartsOnClose()
    {
        var time = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T12:00:00Z"));
        var store = new MediaSourceOfferStore(time);
        var userId = Guid.NewGuid();
        var token = store.CreateOffers(Guid.NewGuid(), userId, "work-a", ["release-a"])["release-a"];

        Assert.True(store.TryAcquire(token, userId, out var playback));
        time.Advance(TimeSpan.FromHours(2));
        _ = store.CreateOffers(Guid.NewGuid(), userId, "work-b", ["release-b"]);
        Assert.True(store.TryAcquire(token, userId, out var concurrentReplay));

        concurrentReplay!.Dispose();
        playback!.Dispose();
        time.Advance(TimeSpan.FromMinutes(9));
        Assert.True(store.TryAcquire(token, userId, out var replay));
        replay!.Dispose();
        time.Advance(TimeSpan.FromMinutes(11));
        Assert.False(store.TryAcquire(token, userId, out _));
    }

    [Fact]
    public void EquivalentProjection_ReusesItsIndexAtCapacity_AndExpiryReclaimsIt()
    {
        var time = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T12:00:00Z"));
        var store = new MediaSourceOfferStore(time);
        var userId = Guid.NewGuid();
        var itemId = Guid.NewGuid();
        var token = store.CreateOffers(itemId, userId, "target-work", ["target-release"])["target-release"];
        for (var index = 1; index < MediaSourceOfferStore.MaxOffers; index++)
        {
            var created = store.CreateOffers(
                Guid.NewGuid(),
                userId,
                $"work-{index}",
                [$"release-{index}"]);
            Assert.Single(created);
        }

        var reused = store.CreateOffers(itemId, userId, "target-work", ["target-release"]);
        Assert.Equal(token, reused["target-release"]);

        time.Advance(TimeSpan.FromMinutes(11));
        var replacement = store.CreateOffers(itemId, userId, "target-work", ["target-release"]);
        Assert.NotEqual(token, replacement["target-release"]);
        Assert.False(store.TryAcquire(token, userId, out _));
    }

    [Fact]
    public void Core_auto_fallback_is_accepted_only_with_same_work_and_matching_attribution()
    {
        var allowed = new HashSet<string>(["release-dead", "release-ready"], StringComparer.Ordinal);
        var valid = new ResolveResponse
        {
            ReleaseId = "release-ready",
            FallbackFromReleaseId = "release-dead",
            Status = "ready",
            Attempts =
            [
                new ResolveAttempt { ReleaseId = "release-dead", Status = "dead" },
                new ResolveAttempt { ReleaseId = "release-ready", Status = "ready" },
            ],
        };

        StreamarrMediaSourceProvider.EnsureResolveWithinOffer(valid, "release-dead", allowed);
        Assert.Throws<InvalidOperationException>(() => StreamarrMediaSourceProvider.EnsureResolveWithinOffer(
            valid with { FallbackFromReleaseId = null }, "release-dead", allowed));
        Assert.Throws<InvalidOperationException>(() => StreamarrMediaSourceProvider.EnsureResolveWithinOffer(
            valid with { ReleaseId = "other-work", FallbackFromReleaseId = "release-dead" }, "release-dead", allowed));
        Assert.Throws<InvalidOperationException>(() => StreamarrMediaSourceProvider.EnsureResolveWithinOffer(
            valid with { Attempts = [new ResolveAttempt { ReleaseId = "other-work", Status = "ready" }] },
            "release-dead",
            allowed));
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan duration) => utcNow += duration;
    }
}
