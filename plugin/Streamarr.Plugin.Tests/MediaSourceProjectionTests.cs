using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
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

    [Fact]
    public void Local_sources_are_stably_ordered_ready_then_downloading_then_remote()
    {
        var work = Work("work-a") with
        {
            Releases =
            [
                new ReleaseDto { ReleaseId = "remote-1", Title = "Remote 1", Indexer = "demo" },
                new ReleaseDto { ReleaseId = "downloading", Title = "Downloading", Indexer = "demo" },
                new ReleaseDto { ReleaseId = "ready", Title = "Ready", Indexer = "demo" },
                new ReleaseDto { ReleaseId = "remote-2", Title = "Remote 2", Indexer = "demo" },
            ],
        };
        var availability = new LocalReleaseAvailabilitySnapshot(
        [
            new LocalReleaseAvailabilityDto { WorkId = "work-a", ReleaseId = "downloading", State = "downloading" },
            new LocalReleaseAvailabilityDto { WorkId = "work-a", ReleaseId = "ready", State = "ready" },
        ]);

        var ordered = StreamarrMediaSourceProjection.OrderReleases(
            work.WorkId,
            work.Releases,
            availability);

        Assert.Equal(
        [
            "ready",
            "downloading",
            "remote-1",
            "remote-2",
        ], ordered.Select(release => release.ReleaseId));
    }

    [Fact]
    public void Local_state_for_the_same_release_id_on_another_work_is_ignored()
    {
        var work = Work("episode-a");
        var availability = new LocalReleaseAvailabilitySnapshot(
        [
            new LocalReleaseAvailabilityDto
            {
                WorkId = "episode-b",
                ReleaseId = "episode-a-r2",
                State = "ready",
            },
        ]);

        var ordered = StreamarrMediaSourceProjection.OrderReleases(
            work.WorkId,
            work.Releases,
            availability);

        Assert.Equal(["episode-a-r1", "episode-a-r2"], ordered.Select(release => release.ReleaseId));
    }

    [Fact]
    public void Local_rank_21_is_merged_offered_and_resolvable_without_raising_the_regular_cap()
    {
        var store = new EphemeralReleaseStore();
        var itemId = Guid.NewGuid();
        var persisted = Enumerable.Range(1, 20)
            .Select(index => new ReleaseDto
            {
                ReleaseId = $"rank-{index}",
                Title = $"Show.S01E02.Rank.{index:D2}-REMOTE",
                Indexer = "demo",
            })
            .ToArray();
        store.Put(itemId, Work("episode-a") with { Releases = persisted });
        var offers = new MediaSourceOfferStore();
        var projection = new StreamarrMediaSourceProjection(
            store,
            offers,
            NullLogger<StreamarrMediaSourceProjection>.Instance);
        var local = new ReleaseDto
        {
            ReleaseId = "rank-21-local",
            Title = "Show.S01E02.German.DL.1080p.WEB-DL-D3GI",
            Indexer = "demo",
            Score = 41,
            AddScoreToName = true,
        };
        var availability = new LocalReleaseAvailabilitySnapshot(
        [
            new LocalReleaseAvailabilityDto
            {
                WorkId = "episode-a",
                ReleaseId = local.ReleaseId,
                State = "ready",
                Release = local,
            },
            new LocalReleaseAvailabilityDto
            {
                WorkId = "another-episode",
                ReleaseId = "cross-scope",
                State = "ready",
                Release = local with { ReleaseId = "cross-scope" },
            },
        ]);
        var offerOwner = Guid.NewGuid();
        var persistedWork = store.Peek(itemId)!.Work;

        var ordered = StreamarrMediaSourceProjection.OrderReleases(
            persistedWork.WorkId,
            persistedWork.Releases,
            availability);
        var capabilities = offers.CreateOffers(
            itemId,
            offerOwner,
            persistedWork.WorkId,
            ordered.Select(release => release.ReleaseId).ToArray(),
            availability.GetTrustedReleaseIds(persistedWork.WorkId),
            ordered.ToDictionary(release => release.ReleaseId, release => release.Title, StringComparer.Ordinal),
            persistedWork.Releases.Select(release => release.ReleaseId).ToHashSet(StringComparer.Ordinal));

        Assert.Equal(21, ordered.Count);
        Assert.Equal(local.ReleaseId, ordered[0].ReleaseId);
        Assert.StartsWith(
            "[D] ",
            MediaSourceMapper.FormatVersionName(ordered[0], availability.GetState("episode-a", local.ReleaseId)),
            StringComparison.Ordinal);
        Assert.Equal(
            Enumerable.Range(1, 20).Select(index => $"rank-{index}"),
            ordered.Skip(1).Select(release => release.ReleaseId));

        Assert.Equal(21, capabilities.Count);
        Assert.True(offers.TryAcquire(capabilities[local.ReleaseId], offerOwner, out var localLease));
        Assert.False(offers.TryAcquire(capabilities[local.ReleaseId], Guid.NewGuid(), out _));
        var offer = localLease!.Offer;
        Assert.Contains(local.ReleaseId, offer.TrustedLocalReleaseIds);
        Assert.Equal(local.Title, offer.ReleaseTitles[local.ReleaseId]);
        Assert.True(StreamarrMediaSourceProvider.OfferMatchesMaterializedWork(
            offer,
            persistedWork,
            local.ReleaseId));
        Assert.False(StreamarrMediaSourceProvider.OfferMatchesMaterializedWork(
            offer,
            persistedWork with { WorkId = "another-episode" },
            local.ReleaseId));

        var localSourceGuid = StreamarrMediaSourceProjection.ReleaseSourceGuid("episode-a", local.ReleaseId);
        Assert.True(projection.TryResolveReleaseSource(localSourceGuid, out var resolvedItemId));
        Assert.Equal(itemId, resolvedItemId);
        localLease.Dispose();
    }

    [Fact]
    public void Local_metadata_forms_a_release_set_when_the_persisted_work_has_no_releases()
    {
        var local = new ReleaseDto
        {
            ReleaseId = "local-only",
            Title = "Show.S01E02.1080p.WEB-DL-D3GI",
            Indexer = "demo",
        };
        var availability = new LocalReleaseAvailabilitySnapshot(
        [
            new LocalReleaseAvailabilityDto
            {
                WorkId = "episode-a",
                ReleaseId = local.ReleaseId,
                State = "ready",
                Release = local,
            },
        ]);

        var ordered = StreamarrMediaSourceProjection.OrderReleases("episode-a", [], availability);

        var release = Assert.Single(ordered);
        Assert.Equal(local.ReleaseId, release.ReleaseId);
        Assert.StartsWith(
            "[D] ",
            MediaSourceMapper.FormatVersionName(release, availability.GetState("episode-a", release.ReleaseId)),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Pins the exact shape official clients require to treat an owned, non-Virtual item as
    /// "navigable but unplayable": a single <c>MediaSourceType.Placeholder</c> source, never an
    /// empty array. Jellyfin Web's item-details "Version" selector only skips its own crashing
    /// <c>MediaSources[0]</c> read when <c>!MediaSources</c> or when there is exactly one source
    /// whose Type is Placeholder (see <c>supportsMediaSourceSelection</c> in jellyfin-web); a bare
    /// empty array satisfies neither guard. <c>StreamarrSearchActionFilter</c> also rewrites every
    /// owned item's LocationType away from Virtual, which is the other guard clients use to avoid
    /// rendering the selector — so the empty-array shape is doubly unsafe for owned items.
    /// </summary>
    [Fact]
    public void Placeholder_source_is_a_single_pathless_entry()
    {
        var itemId = Guid.NewGuid();

        var placeholder = StreamarrMediaSourceProjection.PlaceholderSource(itemId);

        Assert.Equal(MediaSourceType.Placeholder, placeholder.Type);
        Assert.Equal(itemId.ToString("N"), placeholder.Id);
        Assert.True(string.IsNullOrEmpty(placeholder.Path));
    }
}
