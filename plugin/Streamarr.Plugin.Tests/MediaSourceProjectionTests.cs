using MediaBrowser.Controller.Entities;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;
using JellyfinUser = Jellyfin.Database.Implementations.Entities.User;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Pins the DTO-projection contract: which items may be projected at all, and that projected
/// <c>OpenToken</c>s carry Jellyfin's provider-routing prefix so <c>/LiveStreams/Open</c> can
/// dispatch them back to the Streamarr provider. The full user-visible path (detail routes,
/// season listings, auto-open) is covered by the isolated Jellyfin smoke.
/// </summary>
public class MediaSourceProjectionTests
{
    private static WorkDto Work(string workId) => new()
    {
        WorkId = workId,
        MediaType = "movie",
        Title = "Projected Movie",
        RuntimeMinutes = 90,
        Releases =
        [
            new ReleaseDto { ReleaseId = workId + "-r1", Title = "R1", Indexer = "demo", Quality = new QualityDto() },
            new ReleaseDto { ReleaseId = workId + "-r2", Title = "R2", Indexer = "demo", Quality = new QualityDto() },
        ],
    };

    private static StreamarrMediaSourceProjection Projection(EphemeralReleaseStore store)
        => new(store, new MediaSourceOfferStore(), NullLogger<StreamarrMediaSourceProjection>.Instance);

    [Fact]
    public void Host_open_token_prefix_matches_jellyfins_provider_routing_hash()
    {
        // MediaSourceManager.GetProvider routes on MD5(UTF-16LE(provider type full name)) before
        // the first '_'. The literal below was computed independently for the current provider
        // type; renaming/moving StreamarrMediaSourceProvider breaks token routing and this test.
        Assert.Equal(
            "fb1f171b03e7c0455b4eb752336de03f_",
            StreamarrMediaSourceProjection.HostOpenTokenPrefix);
    }

    [Fact]
    public void Host_open_token_prefix_is_applied_exactly_once()
    {
        var once = StreamarrMediaSourceProjection.WithHostOpenTokenPrefix("capability");

        Assert.Equal(StreamarrMediaSourceProjection.HostOpenTokenPrefix + "capability", once);
        Assert.Equal(once, StreamarrMediaSourceProjection.WithHostOpenTokenPrefix(once));
    }

    [Fact]
    public void Release_source_ids_are_guid_shaped_and_deterministic()
    {
        // Jellyfin Web fetches the selected media-source id as an item id and Android TV parses
        // it as a UUID, so raw Core release ids would break version selection in real clients.
        var first = StreamarrMediaSourceProjection.ReleaseSourceId("work-a", "rel-1");

        Assert.Equal(first, StreamarrMediaSourceProjection.ReleaseSourceId("work-a", "rel-1"));
        Assert.NotEqual(first, StreamarrMediaSourceProjection.ReleaseSourceId("work-a", "rel-2"));
        Assert.NotEqual(first, StreamarrMediaSourceProjection.ReleaseSourceId("work-b", "rel-1"));
        Assert.Matches("^[0-9a-f]{32}$", first);
        Assert.True(Guid.TryParse(first, out var parsed));
        Assert.Equal(StreamarrMediaSourceProjection.ReleaseSourceGuid("work-a", "rel-1"), parsed);
    }

    [Fact]
    public async Task Release_source_guids_resolve_back_to_their_owning_item()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        Assert.True(await store.PutRangeAsync(
            [new KeyValuePair<Guid, WorkDto>(itemId, Work("work-a"))],
            CancellationToken.None));
        var projection = Projection(store);

        var sourceGuid = StreamarrMediaSourceProjection.ReleaseSourceGuid("work-a", "work-a-r2");
        Assert.True(projection.TryResolveReleaseSource(sourceGuid, out var ownerId));
        Assert.Equal(itemId, ownerId);
        Assert.False(projection.TryResolveReleaseSource(Guid.NewGuid(), out _));
        Assert.False(projection.TryResolveReleaseSource(Guid.Empty, out _));
    }

    [Fact]
    public void Items_without_release_state_are_never_projected()
    {
        var store = new EphemeralReleaseStore();
        var projection = Projection(store);
        var item = new Folder { Id = Guid.NewGuid() };

        Assert.False(projection.Owns(item.Id));
        Assert.False(projection.TryProject(item, user: null, Guid.NewGuid(), out var sources));
        Assert.Empty(sources);
    }

    [Fact]
    public async Task Owned_item_without_an_authenticated_identity_projects_zero_sources()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        Assert.True(await store.PutRangeAsync(
            [new KeyValuePair<Guid, WorkDto>(itemId, Work("work-a"))],
            CancellationToken.None));
        var projection = Projection(store);
        var item = new Folder { Id = itemId };

        Assert.True(projection.Owns(itemId));

        // No resolvable user at all.
        Assert.True(projection.TryProject(item, user: null, Guid.NewGuid(), out var sources));
        Assert.Empty(sources);

        // A target user without an authenticated claim must not mint unredeemable offers.
        var user = new JellyfinUser("projection-tester", "auth-provider", "reset-provider");
        Assert.True(projection.TryProject(item, user, Guid.Empty, out sources));
        Assert.Empty(sources);
    }
}
