using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.ScheduledTasks;
using Streamarr.Plugin.Search;

namespace Streamarr.Plugin.Tests;

public class HierarchyLifecycleTests
{
    private static readonly DateTime Now = new(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Pathless_streamarr_items_report_remote_instead_of_missing_to_clients()
    {
        BaseItem[] items =
        [
            new StreamarrMovie(),
            new StreamarrSeries(),
            new StreamarrSeason(),
            new StreamarrEpisode(),
        ];

        Assert.All(items, item => Assert.Equal(LocationType.Remote, item.LocationType));
    }

    [Fact]
    public void Hierarchy_completion_rejects_virtual_or_unlinked_legacy_children()
    {
        var series = new StreamarrSeries
        {
            Id = Guid.NewGuid(),
            PresentationUniqueKey = "streamarr-series-key",
        };
        var season = new StreamarrSeason
        {
            Id = Guid.NewGuid(),
            ParentId = series.Id,
            SeriesId = series.Id,
            PresentationUniqueKey = "streamarr-series-key-001",
            SeriesPresentationUniqueKey = series.PresentationUniqueKey,
            IsVirtualItem = false,
        };
        var episode = new StreamarrEpisode
        {
            Id = Guid.NewGuid(),
            ParentId = season.Id,
            SeasonId = season.Id,
            SeriesId = series.Id,
            SeriesPresentationUniqueKey = series.PresentationUniqueKey,
            IsVirtualItem = false,
        };

        Assert.True(EphemeralLibraryService.HasNavigableHierarchyMetadata(
            series,
            season,
            Jellyfin.Data.Enums.BaseItemKind.Season));
        Assert.True(EphemeralLibraryService.HasNavigableHierarchyMetadata(
            season,
            episode,
            Jellyfin.Data.Enums.BaseItemKind.Episode));

        season.IsVirtualItem = true;
        Assert.False(EphemeralLibraryService.HasNavigableHierarchyMetadata(
            series,
            season,
            Jellyfin.Data.Enums.BaseItemKind.Season));
        season.IsVirtualItem = false;
        season.SeriesPresentationUniqueKey = null!;
        Assert.False(EphemeralLibraryService.HasNavigableHierarchyMetadata(
            series,
            season,
            Jellyfin.Data.Enums.BaseItemKind.Season));

        season.SeriesPresentationUniqueKey = series.PresentationUniqueKey;
        episode.IsVirtualItem = true;
        Assert.False(EphemeralLibraryService.HasNavigableHierarchyMetadata(
            season,
            episode,
            Jellyfin.Data.Enums.BaseItemKind.Episode));
    }

    [Fact]
    public void Flat_owned_tv_item_can_move_to_hierarchy_but_unrelated_item_cannot()
    {
        var folderId = Guid.NewGuid();
        var stagingFolderId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var workId = "tmdb-tv-37680-s01e01";
        var flat = OwnedItem(folderId, workId);

        Assert.True(EphemeralLibraryService.CanAdoptHierarchyItem(flat, seasonId, folderId, stagingFolderId, workId));

        flat.ParentId = seasonId;
        Assert.True(EphemeralLibraryService.CanAdoptHierarchyItem(flat, seasonId, folderId, stagingFolderId, workId));
        Assert.False(EphemeralLibraryService.CanAdoptHierarchyItem(flat, Guid.NewGuid(), folderId, stagingFolderId, workId));
        Assert.False(EphemeralLibraryService.CanAdoptHierarchyItem(flat, seasonId, folderId, stagingFolderId, "another-work"));

        // Items parented below the hidden staging root are equally adoptable; foreign parents stay rejected.
        var staged = OwnedItem(stagingFolderId, workId);
        Assert.True(EphemeralLibraryService.CanAdoptHierarchyItem(staged, seasonId, folderId, stagingFolderId, workId));
        var foreign = OwnedItem(Guid.NewGuid(), workId);
        Assert.False(EphemeralLibraryService.CanAdoptHierarchyItem(foreign, seasonId, folderId, stagingFolderId, workId));
    }

    [Fact]
    public void Missing_invalid_or_mismatched_completion_marker_requires_reconciliation()
    {
        var parent = new Folder();

        Assert.False(EphemeralLibraryService.HasExpectedChildCount(parent, 1));

        parent.ProviderIds[EphemeralLibraryService.ExpectedChildCountProviderKey] = "invalid";
        Assert.False(EphemeralLibraryService.HasExpectedChildCount(parent, 1));

        parent.ProviderIds[EphemeralLibraryService.ExpectedChildCountProviderKey] = "2";
        Assert.False(EphemeralLibraryService.HasExpectedChildCount(parent, 1));
        Assert.True(EphemeralLibraryService.HasExpectedChildCount(parent, 2));
    }

    [Fact]
    public void Episode_completion_requires_release_state_for_every_canonical_child()
    {
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        var parent = new Folder
        {
            ProviderIds = new Dictionary<string, string>
            {
                [EphemeralLibraryService.ExpectedChildCountProviderKey] = "2",
            },
        };

        Assert.True(EphemeralLibraryService.HasCompleteChildSet(parent, [first, second], _ => true));
        Assert.False(EphemeralLibraryService.HasCompleteChildSet(
            parent,
            [first, second],
            itemId => itemId == first));
    }

    [Fact]
    public void Active_episode_rolls_access_up_and_old_leaf_is_evicted_before_ancestors()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var activeEpisodeId = Guid.NewGuid();
        var oldEpisodeId = Guid.NewGuid();
        var candidates = EphemeralLifecycle.Build(
        [
            new EphemeralLifecycle.Node(seriesId, Guid.NewGuid(), Now.AddHours(-30)),
            new EphemeralLifecycle.Node(seasonId, seriesId, Now.AddHours(-30)),
            new EphemeralLifecycle.Node(activeEpisodeId, seasonId, Now.AddMinutes(-1)),
            new EphemeralLifecycle.Node(oldEpisodeId, seasonId, Now.AddHours(-20)),
        ]);

        var series = Assert.Single(candidates, item => item.ItemId == seriesId);
        var season = Assert.Single(candidates, item => item.ItemId == seasonId);

        Assert.Equal(Now.AddMinutes(-1), series.EffectiveLastAccessUtc);
        Assert.Equal(Now.AddMinutes(-1), season.EffectiveLastAccessUtc);
        Assert.Equal(4, series.SubtreeIds.Count);
        Assert.Equal(oldEpisodeId, candidates
            .OrderBy(item => item.EffectiveLastAccessUtc ?? DateTime.MinValue)
            .ThenByDescending(item => item.SubtreeIds.Count)
            .First()
            .ItemId);
    }

    [Fact]
    public void Bug_repro_next_up_episode_is_deleted_by_ttl_cleanup_even_though_series_is_being_watched()
    {
        // Reproduces the reported bug: the user finished episode 1 (engaged: Played=true), which
        // is exactly what makes episode 2 Jellyfin's "Next Up" candidate for this series. Nobody
        // has ever streamed episode 2, so its own last-access clock never moved past the moment
        // it was materialized (e.g. when the season page was first opened) and it ages out on the
        // default 12h TTL like any item nobody cares about — even though the series is actively
        // being watched. This mirrors EphemeralCleanupTask.ExecuteAsync's real candidate loop.
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var watchedEpisodeId = Guid.NewGuid();
        var nextUpEpisodeId = Guid.NewGuid();
        var ttl = TimeSpan.FromHours(12); // default EphemeralTtlMinutes = 720

        var candidates = EphemeralLifecycle.Build(
        [
            new EphemeralLifecycle.Node(seriesId, Guid.NewGuid(), Now.AddDays(-2)),
            new EphemeralLifecycle.Node(seasonId, seriesId, Now.AddDays(-2)),
            new EphemeralLifecycle.Node(watchedEpisodeId, seasonId, Now.AddDays(-2), IsEngaged: true),
            // Materialized 13 hours ago (season browsed, episode listed as Next Up) but never
            // streamed since — just past the default 12h TTL.
            new EphemeralLifecycle.Node(nextUpEpisodeId, seasonId, Now.AddHours(-13)),
        ]);

        var lifecycle = candidates
            .Select(c => new EphemeralLibraryService.LifecycleItem(
                new Folder { Id = c.ItemId }, c.SubtreeIds, c.EffectiveLastAccessUtc, c.IsEngaged, c.IsPromoted))
            .ToList();

        var selected = EphemeralLifecycle.OrderForDeletion(lifecycle)
            .FirstOrDefault(item => !item.IsEngaged && EphemeralCleanup.IsExpired(item.EffectiveLastAccessUtc, Now, ttl));

        Assert.NotNull(selected);
        Assert.Equal(nextUpEpisodeId, selected!.Item.Id);
    }

    [Fact]
    public void Fix_next_up_episode_is_protected_once_it_follows_an_engaged_episode_in_series_order()
    {
        // Same scenario as the bug repro above, but with the series/season/episode ordinal
        // metadata that EphemeralLibraryService.GetLifecycleItems() now supplies. Episode 2
        // immediately follows engaged episode 1, so it must be protected from TTL cleanup too.
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var watchedEpisodeId = Guid.NewGuid();
        var nextUpEpisodeId = Guid.NewGuid();
        var untouchedFutureEpisodeId = Guid.NewGuid();
        var ttl = TimeSpan.FromHours(12);

        var candidates = EphemeralLifecycle.Build(
        [
            new EphemeralLifecycle.Node(seriesId, Guid.NewGuid(), Now.AddDays(-2)),
            new EphemeralLifecycle.Node(seasonId, seriesId, Now.AddDays(-2)),
            new EphemeralLifecycle.Node(
                watchedEpisodeId, seasonId, Now.AddDays(-2),
                IsEngaged: true, SeriesId: seriesId, SeasonNumber: 1, EpisodeNumber: 1),
            new EphemeralLifecycle.Node(
                nextUpEpisodeId, seasonId, Now.AddHours(-13),
                SeriesId: seriesId, SeasonNumber: 1, EpisodeNumber: 2),
            // A third, not-yet-adjacent episode must NOT be swept into protection — only the
            // immediate Next Up candidate is exempt, not the rest of the season.
            new EphemeralLifecycle.Node(
                untouchedFutureEpisodeId, seasonId, Now.AddHours(-13),
                SeriesId: seriesId, SeasonNumber: 1, EpisodeNumber: 3),
        ]);

        Assert.True(Assert.Single(candidates, c => c.ItemId == nextUpEpisodeId).IsEngaged);
        Assert.False(Assert.Single(candidates, c => c.ItemId == untouchedFutureEpisodeId).IsEngaged);

        var lifecycle = candidates
            .Select(c => new EphemeralLibraryService.LifecycleItem(
                new Folder { Id = c.ItemId }, c.SubtreeIds, c.EffectiveLastAccessUtc, c.IsEngaged, c.IsPromoted))
            .ToList();

        var selected = EphemeralLifecycle.OrderForDeletion(lifecycle)
            .FirstOrDefault(item => !item.IsEngaged && EphemeralCleanup.IsExpired(item.EffectiveLastAccessUtc, Now, ttl));

        Assert.NotNull(selected);
        Assert.Equal(untouchedFutureEpisodeId, selected!.Item.Id);
    }

    [Fact]
    public void Cleanup_revalidation_rejects_recent_or_changed_subtree()
    {
        var root = Guid.NewGuid();
        var child = Guid.NewGuid();
        var expected = new HashSet<Guid> { root, child };
        var cutoff = Now.AddHours(-12);

        Assert.True(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), cutoff.AddMinutes(-1), cutoff, capacityOverflow: false, isEngaged: false, isPromoted: false));
        Assert.False(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), Now, cutoff, capacityOverflow: false, isEngaged: false, isPromoted: false));
        Assert.False(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid> { root, child, Guid.NewGuid() }, cutoff.AddMinutes(-1), cutoff, false, false, false));
        Assert.True(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), Now, cutoff, capacityOverflow: true, isEngaged: false, isPromoted: false));
    }

    [Fact]
    public void Engaged_subtrees_never_expire_by_ttl_but_yield_to_capacity_pressure()
    {
        var root = Guid.NewGuid();
        var expected = new HashSet<Guid> { root };
        var cutoff = Now.AddHours(-12);

        // Expired by TTL yet engaged (resume position / favorite / watched) → protected.
        Assert.False(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), cutoff.AddDays(-7), cutoff, capacityOverflow: false, isEngaged: true, isPromoted: false));
        // The hard capacity bound still wins over engagement.
        Assert.True(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), cutoff.AddDays(-7), cutoff, capacityOverflow: true, isEngaged: true, isPromoted: false));
    }

    [Fact]
    public void Promoted_history_subtrees_are_never_deletable_even_under_capacity_overflow()
    {
        var root = Guid.NewGuid();
        var expected = new HashSet<Guid> { root };
        var cutoff = Now.AddHours(-12);

        // The promoted library history survives TTL expiry AND the hard capacity bound; only an
        // explicit un-engage (demotion back to staging) makes it reachable for cleanup again.
        Assert.False(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), cutoff.AddDays(-30), cutoff, capacityOverflow: false, isEngaged: false, isPromoted: true));
        Assert.False(EphemeralLibraryService.CanDeleteLifecycleCandidate(
            expected, new HashSet<Guid>(expected), cutoff.AddDays(-30), cutoff, capacityOverflow: true, isEngaged: true, isPromoted: true));
    }

    [Fact]
    public void Library_root_marks_its_whole_subtree_promoted_and_staging_stays_unpromoted()
    {
        var promotedSeriesId = Guid.NewGuid();
        var promotedSeasonId = Guid.NewGuid();
        var promotedEpisodeId = Guid.NewGuid();
        var stagedMovieId = Guid.NewGuid();
        var candidates = EphemeralLifecycle.Build(
        [
            new EphemeralLifecycle.Node(promotedSeriesId, Guid.NewGuid(), Now.AddDays(-30), IsLibraryRoot: true),
            new EphemeralLifecycle.Node(promotedSeasonId, promotedSeriesId, Now.AddDays(-30)),
            new EphemeralLifecycle.Node(promotedEpisodeId, promotedSeasonId, Now.AddDays(-30)),
            new EphemeralLifecycle.Node(stagedMovieId, Guid.NewGuid(), Now.AddDays(-30)),
        ]);

        Assert.True(Assert.Single(candidates, c => c.ItemId == promotedSeriesId).IsPromoted);
        Assert.True(Assert.Single(candidates, c => c.ItemId == promotedSeasonId).IsPromoted);
        Assert.True(Assert.Single(candidates, c => c.ItemId == promotedEpisodeId).IsPromoted);
        Assert.False(Assert.Single(candidates, c => c.ItemId == stagedMovieId).IsPromoted);
    }

    [Fact]
    public void Engagement_rolls_up_to_ancestors_and_orders_engaged_subtrees_last()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var engagedEpisodeId = Guid.NewGuid();
        var idleMovieId = Guid.NewGuid();
        var candidates = EphemeralLifecycle.Build(
        [
            new EphemeralLifecycle.Node(seriesId, Guid.NewGuid(), Now.AddDays(-9)),
            new EphemeralLifecycle.Node(seasonId, seriesId, Now.AddDays(-9)),
            new EphemeralLifecycle.Node(engagedEpisodeId, seasonId, Now.AddDays(-9), IsEngaged: true),
            new EphemeralLifecycle.Node(idleMovieId, Guid.NewGuid(), Now.AddMinutes(-1)),
        ]);

        // A half-watched episode protects its season and series from TTL expiry.
        Assert.True(Assert.Single(candidates, item => item.ItemId == seriesId).IsEngaged);
        Assert.True(Assert.Single(candidates, item => item.ItemId == seasonId).IsEngaged);
        Assert.False(Assert.Single(candidates, item => item.ItemId == idleMovieId).IsEngaged);

        // Under capacity pressure the idle movie goes first even though the engaged series
        // subtree was accessed far longer ago.
        var ordered = EphemeralLifecycle.OrderForDeletion(
        [
            Lifecycle(seriesId, isEngaged: true, seriesId, seasonId, engagedEpisodeId),
            Lifecycle(idleMovieId, isEngaged: false, idleMovieId),
        ]).ToList();
        Assert.Equal(idleMovieId, ordered[0].Item.Id);
        Assert.Equal(seriesId, ordered[1].Item.Id);
    }

    [Fact]
    public void Authoritative_child_selection_prunes_only_absent_owned_direct_children()
    {
        var parentId = Guid.NewGuid();
        var keep = OwnedEpisode(parentId, "keep");
        var stale = OwnedEpisode(parentId, "stale");
        var nested = OwnedEpisode(stale.Id, "nested");
        var foreign = new StreamarrEpisode { Id = Guid.NewGuid(), ParentId = parentId };

        var selected = EphemeralLibraryService.SelectStaleDirectChildren(
            [keep, stale, nested, foreign],
            parentId,
            Jellyfin.Data.Enums.BaseItemKind.Episode,
            new HashSet<Guid> { keep.Id });

        Assert.Equal(stale.Id, Assert.Single(selected).Id);
    }

    [Fact]
    public void Recursive_series_preflight_counts_series_seasons_and_all_episodes()
    {
        Assert.Equal(9, EphemeralLibraryService.ProjectedSeriesHierarchyItemCount([2, 4]));
        Assert.True(EphemeralLibraryService.ProjectedSeriesHierarchyItemCount([100, 100])
                    <= EphemeralLibraryService.MaxEphemeralItems);
        Assert.True(EphemeralLibraryService.ProjectedSeriesHierarchyItemCount([250, 250])
                    > EphemeralLibraryService.MaxEphemeralItems);
        Assert.Equal(long.MaxValue, EphemeralLibraryService.ProjectedSeriesHierarchyItemCount([-1]));
    }

    [Fact]
    public async Task Store_batches_hierarchy_persistence_and_subtree_removal()
    {
        var directory = Path.Combine(Path.GetTempPath(), "streamarr-plugin-tests", Guid.NewGuid().ToString("N"));
        var path = Path.Combine(directory, "ephemeral-releases.json");
        var firstId = Guid.NewGuid();
        var secondId = Guid.NewGuid();
        try
        {
            var store = new EphemeralReleaseStore(path);
            await store.PutRangeAsync(
            [
                new KeyValuePair<Guid, WorkDto>(firstId, Work("first")),
                new KeyValuePair<Guid, WorkDto>(secondId, Work("second")),
            ], CancellationToken.None);

            var restored = new EphemeralReleaseStore(path);
            Assert.Equal(2, restored.All().Count);
            Assert.Equal(2, restored.RemoveRange([firstId, secondId]));
            Assert.Empty(new EphemeralReleaseStore(path).All());
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task Store_reports_batch_persistence_failure_so_completion_is_not_committed()
    {
        var root = Path.Combine(Path.GetTempPath(), "streamarr-plugin-tests", Guid.NewGuid().ToString("N"));
        var path = Path.Combine(root, "cache-path-is-a-directory");
        try
        {
            Directory.CreateDirectory(path);
            var store = new EphemeralReleaseStore(path);

            var persisted = await store.PutRangeAsync(
                [new KeyValuePair<Guid, WorkDto>(Guid.NewGuid(), Work("episode"))],
                CancellationToken.None);

            Assert.False(persisted);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Coordinator_coalesces_fetch_and_removes_owner_after_completion()
    {
        var coordinator = new HierarchyLoadCoordinator();
        var key = new HierarchyLoadCoordinator.Key(37680, 1);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;

        async Task<string?> Fetch(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            entered.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return "season";
        }

        var firstLease = coordinator.Acquire(key, TimeSpan.FromSeconds(2), Fetch);
        var first = firstLease.FetchAsync(CancellationToken.None);
        await entered.Task;
        var secondLease = coordinator.Acquire(key, TimeSpan.FromSeconds(2), Fetch);
        var second = secondLease.FetchAsync(CancellationToken.None);
        release.SetResult();
        var results = await Task.WhenAll(first, second);

        Assert.Equal(1, calls);
        Assert.Equal(new string?[] { "season", "season" }, results);

        // A caller arriving after Core returned but before marker commit reuses the retained result.
        var lateLease = coordinator.Acquire(key, TimeSpan.FromSeconds(2), Fetch);
        Assert.Equal("season", await lateLease.FetchAsync(CancellationToken.None));
        Assert.Equal(1, calls);
        Assert.Equal(1, coordinator.ActiveLoadCount);

        firstLease.Dispose();
        secondLease.Dispose();
        lateLease.Dispose();
        Assert.Equal(0, coordinator.ActiveLoadCount);

        using var refetchLease = coordinator.Acquire(key, TimeSpan.FromSeconds(2), _ =>
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult<string?>("refetched");
        });
        Assert.Equal("refetched", await refetchLease.FetchAsync(CancellationToken.None));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Coordinator_bounds_wait_without_starting_overlapping_retry()
    {
        var coordinator = new HierarchyLoadCoordinator();
        var key = new HierarchyLoadCoordinator.Key(37680, 1);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;

        async Task<string?> IgnoreCancellation(CancellationToken _)
        {
            Interlocked.Increment(ref calls);
            await release.Task;
            return "season";
        }

        var firstLease = coordinator.Acquire(key, TimeSpan.FromMilliseconds(50), IgnoreCancellation);
        await Assert.ThrowsAsync<TimeoutException>(() => firstLease.FetchAsync(CancellationToken.None));
        firstLease.Dispose();
        var secondLease = coordinator.Acquire(key, TimeSpan.FromMilliseconds(50), IgnoreCancellation);
        await Assert.ThrowsAsync<TimeoutException>(() => secondLease.FetchAsync(CancellationToken.None));
        secondLease.Dispose();
        Assert.Equal(1, calls);

        release.SetResult();
        for (var attempt = 0; attempt < 100 && coordinator.ActiveLoadCount > 0; attempt++)
            await Task.Delay(1);
        Assert.Equal(0, coordinator.ActiveLoadCount);
        using var retryLease = coordinator.Acquire(key, TimeSpan.FromSeconds(1), _ =>
        {
            Interlocked.Increment(ref calls);
            return Task.FromResult<string?>("refetched");
        });
        Assert.Equal("refetched", await retryLease.FetchAsync(CancellationToken.None));
        Assert.Equal(2, calls);
    }

    [Fact]
    public async Task Coordinator_shares_fetch_but_callers_keep_their_capacity_modes()
    {
        var coordinator = new HierarchyLoadCoordinator();
        var key = new HierarchyLoadCoordinator.Key(37680, 1);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;

        async Task<string?> Fetch(CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            entered.TrySetResult();
            await release.Task.WaitAsync(cancellationToken);
            return "shared-season-details";
        }

        async Task<bool> OpenSeason(bool protectSeriesHierarchy)
        {
            using var hierarchyLoad = coordinator.Acquire(
                key,
                TimeSpan.FromSeconds(1),
                Fetch);
            var details = await hierarchyLoad.FetchAsync(CancellationToken.None);
            Assert.Equal("shared-season-details", details);
            // Materialization happens after FetchAsync, under EphemeralLibraryService's gate, so
            // the caller-owned policy is not captured by whichever fetch delegate won the race.
            return protectSeriesHierarchy;
        }

        var direct = OpenSeason(protectSeriesHierarchy: false);
        await entered.Task;
        var recursive = OpenSeason(protectSeriesHierarchy: true);
        release.SetResult();
        var modes = await Task.WhenAll(direct, recursive);

        Assert.Equal(1, calls);
        Assert.Equal([false, true], modes);
    }

    [Fact]
    public void Recursive_reservation_protects_the_whole_series_but_direct_scope_does_not()
    {
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var episodeId = Guid.NewGuid();
        var unrelatedId = Guid.NewGuid();
        var lifecycle = new List<EphemeralLibraryService.LifecycleItem>
        {
            Lifecycle(seriesId, seriesId, seasonId, episodeId),
            Lifecycle(seasonId, seasonId, episodeId),
            Lifecycle(episodeId, episodeId),
            Lifecycle(unrelatedId, unrelatedId),
        };

        var directProtection = EphemeralLibraryService.SelectProtectedHierarchyIds(
            lifecycle,
            new HashSet<Guid> { seriesId, seasonId, episodeId },
            protectDescendantsOfProtectedItems: false,
            new HashSet<Guid>());
        var recursiveProtection = EphemeralLibraryService.SelectProtectedHierarchyIds(
            lifecycle,
            new HashSet<Guid> { seriesId, seasonId, episodeId },
            protectDescendantsOfProtectedItems: false,
            new HashSet<Guid> { seriesId });

        Assert.Empty(directProtection);
        Assert.True(recursiveProtection.SetEquals(new[] { seriesId, seasonId, episodeId }));
        Assert.DoesNotContain(unrelatedId, recursiveProtection);
    }

    private static BaseItem OwnedItem(Guid parentId, string workId) => new Folder
    {
        Id = Guid.NewGuid(),
        ParentId = parentId,
        ProviderIds = new Dictionary<string, string>
        {
            [EphemeralLibraryService.OwnerProviderKey] = EphemeralLibraryService.OwnerProviderValue,
            [EphemeralLibraryService.WorkIdProviderKey] = workId,
        },
    };

    private static StreamarrEpisode OwnedEpisode(Guid parentId, string workId) => new()
    {
        Id = Guid.NewGuid(),
        ParentId = parentId,
        ProviderIds = new Dictionary<string, string>
        {
            [EphemeralLibraryService.OwnerProviderKey] = EphemeralLibraryService.OwnerProviderValue,
            [EphemeralLibraryService.WorkIdProviderKey] = workId,
        },
    };

    private static EphemeralLibraryService.LifecycleItem Lifecycle(
        Guid itemId,
        params Guid[] subtreeIds)
        => Lifecycle(itemId, isEngaged: false, subtreeIds);

    private static EphemeralLibraryService.LifecycleItem Lifecycle(
        Guid itemId,
        bool isEngaged,
        params Guid[] subtreeIds)
        => new(
            new Folder { Id = itemId },
            subtreeIds.ToHashSet(),
            Now,
            isEngaged,
            IsPromoted: false);

    private static WorkDto Work(string workId) => new()
    {
        WorkId = workId,
        Title = workId,
        MediaType = "episode",
    };
}
