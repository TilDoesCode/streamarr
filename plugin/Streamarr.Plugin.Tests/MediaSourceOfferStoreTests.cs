using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Tests;

public class MediaSourceOfferStoreTests
{
    [Fact]
    public void Offer_is_opaque_one_use_and_bound_to_the_authenticated_user()
    {
        var store = new MediaSourceOfferStore();
        var itemId = Guid.NewGuid();
        var owner = Guid.NewGuid();
        var otherUser = Guid.NewGuid();
        var created = store.CreateOffers(itemId, owner, "work-a", ["release-a", "release-b"]);
        var token = created["release-a"];

        Assert.NotEqual("release-a", token);
        Assert.False(store.TryTake(token, otherUser, out _));
        Assert.True(store.TryTake(token, owner, out var offer));
        Assert.Equal(itemId, offer!.ItemId);
        Assert.Equal("work-a", offer.WorkId);
        Assert.Equal("release-a", offer.ReleaseId);
        Assert.Contains("release-b", offer.AllowedReleaseIds);
        Assert.False(store.TryTake(token, owner, out _));
    }

    [Fact]
    public void Unknown_or_cross_work_release_cannot_be_opened_by_an_offer()
    {
        var store = new MediaSourceOfferStore();
        var userId = Guid.NewGuid();
        var created = store.CreateOffers(Guid.NewGuid(), userId, "work-a", ["release-a"]);

        Assert.False(store.TryTake("release-a", userId, out _));
        Assert.True(store.TryTake(created["release-a"], userId, out var offer));
        Assert.DoesNotContain("release-from-work-b", offer!.AllowedReleaseIds);
    }

    [Fact]
    public void A_second_playback_info_request_does_not_invalidate_the_first_device_offer()
    {
        var store = new MediaSourceOfferStore();
        var itemId = Guid.NewGuid();
        var userId = Guid.NewGuid();
        var first = store.CreateOffers(itemId, userId, "work-a", ["release-a"])["release-a"];
        var second = store.CreateOffers(itemId, userId, "work-a", ["release-a"])["release-a"];

        Assert.NotEqual(first, second);
        Assert.True(store.TryTake(first, userId, out _));
        Assert.True(store.TryTake(second, userId, out _));
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
}
