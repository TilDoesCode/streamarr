using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.ScheduledTasks;

/// <summary>
/// TTL cleanup for plugin-owned ephemeral Usenet items (BRIEF §8.5). Deletes items whose
/// <c>lastAccessedUtc</c> is older than the bounded configured TTL, closes tracked Core sessions,
/// enforces the hard item limit, and prunes the persisted release cache. After restart, Jellyfin's
/// saved/created timestamp is a conservative fallback when no cache timestamp is available.
/// Runs hourly by default. No domain logic: it is pure lifecycle bookkeeping (BRIEF §11).
/// </summary>
public sealed class EphemeralCleanupTask(
    EphemeralLibraryService library,
    PlaybackSessionTracker tracker,
    StreamarrApiClient api,
    ILogger<EphemeralCleanupTask> logger) : IScheduledTask
{
    public string Name => "Streamarr: clean up ephemeral items";

    public string Key => "StreamarrEphemeralCleanup";

    public string Description =>
        "Delete Usenet ephemeral items whose TTL has expired and close their lingering sessions (BRIEF §8.5).";

    public string Category => "Streamarr";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);

        var ttlMinutes = Math.Clamp(
            Plugin.Instance?.Configuration.EphemeralTtlMinutes ?? Configuration.PluginConfiguration.MinEphemeralTtlMinutes,
            Configuration.PluginConfiguration.MinEphemeralTtlMinutes,
            Configuration.PluginConfiguration.MaxEphemeralTtlMinutes);

        var ttl = TimeSpan.FromMinutes(ttlMinutes);
        var now = DateTime.UtcNow;

        var prunedReleaseEntries = await library.PruneOrphanedReleaseStateAsync(cancellationToken)
            .ConfigureAwait(false);
        var initialCount = library.GetEphemeralItems().Count;
        var failedSubtrees = new HashSet<Guid>();
        var deleted = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var lifecycle = library.GetLifecycleItems();
            var overflow = Math.Max(0, lifecycle.Count - EphemeralLibraryService.MaxEphemeralItems);
            // Engaged subtrees (resume position, favorite, or watched state for any user) never
            // expire by TTL: deleting them would silently clear the user's Continue Watching,
            // Favorites, or Next Up state. Capacity overflow may still evict them — last.
            var candidate = EphemeralLifecycle
                .OrderForDeletion(lifecycle)
                .FirstOrDefault(item => !item.SubtreeIds.Any(failedSubtrees.Contains)
                                        && (overflow > 0
                                            || (!item.IsEngaged
                                                && EphemeralCleanup.IsExpired(item.EffectiveLastAccessUtc, now, ttl))));
            if (candidate is null)
                break;

            try
            {
                if (!tracker.TryClaimItemsForDeletion(
                        candidate.SubtreeIds,
                        requireNoSessions: false,
                        out var sessions))
                {
                    failedSubtrees.UnionWith(candidate.SubtreeIds);
                    continue;
                }

                try
                {
                    var deletedIds = await library.TryDeleteLifecycleTreeAsync(
                            candidate.Item.Id,
                            candidate.SubtreeIds,
                            now - ttl,
                            cancellationToken)
                        .ConfigureAwait(false);
                    if (deletedIds.Count == 0)
                    {
                        continue;
                    }

                    deleted += deletedIds.Count;
                    foreach (var session in sessions)
                    {
                        if (session.SessionToken is not { } token)
                            continue;

                        using var closeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                        closeTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                        try
                        {
                            await api.CloseSessionAsync(token, closeTimeout.Token).ConfigureAwait(false);
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                        {
                            // Core also expires sessions by TTL; deletion must not be held hostage
                            // by a temporarily unavailable server.
                            logger.LogWarning(
                                "Failed to close session for expired subtree {ItemId} ({FailureType})",
                                candidate.Item.Id,
                            ex.GetType().Name);
                        }
                    }
                }
                finally
                {
                    tracker.ReleaseDeletionClaim(candidate.SubtreeIds);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                failedSubtrees.UnionWith(candidate.SubtreeIds);
                logger.LogWarning(ex, "Failed to delete expired ephemeral subtree {ItemId}", candidate.Item.Id);
            }

            progress.Report(initialCount == 0 ? 100 : Math.Min(100, deleted * 100.0 / initialCount));
        }

        logger.LogInformation(
            "Ephemeral cleanup: deleted {Deleted} of {Total} ephemeral item(s) past a {Ttl} TTL and pruned {Pruned} orphaned release entry(s)",
            deleted, initialCount, ttl, prunedReleaseEntries);
        progress.Report(100);
    }

    // Hourly by default; the TTL itself (config) decides how old an item must be to go.
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() =>
    [
        new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(1).Ticks,
        },
    ];
}

/// <summary>Pure TTL-expiry decision, split out so it is unit-testable without a Jellyfin host.</summary>
public static class EphemeralCleanup
{
    /// <summary>
    /// Restores a conservative access timestamp when the file cache is unavailable after restart.
    /// Unknown items age from Jellyfin's saved/created timestamps rather than being deleted at once.
    /// </summary>
    public static DateTime? ResolveLastAccess(
        DateTime? storedLastAccessUtc,
        DateTime dateLastSavedUtc,
        DateTime dateCreatedUtc)
    {
        if (storedLastAccessUtc is not null)
            return storedLastAccessUtc;
        if (dateLastSavedUtc != DateTime.MinValue)
            return dateLastSavedUtc;
        return dateCreatedUtc != DateTime.MinValue ? dateCreatedUtc : null;
    }

    /// <summary>
    /// An item is expired when its resolved last-access time is unknown or older than the TTL
    /// relative to <paramref name="nowUtc"/>.
    /// </summary>
    public static bool IsExpired(DateTime? lastAccessedUtc, DateTime nowUtc, TimeSpan ttl)
        => lastAccessedUtc is not { } last || nowUtc - last > ttl;
}
