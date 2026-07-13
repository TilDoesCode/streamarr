using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.ScheduledTasks;

/// <summary>
/// TTL cleanup for ephemeral Usenet items (BRIEF §8.5). Deletes <c>usenet-ephemeral</c> items
/// whose <c>lastAccessedUtc</c> is older than the configured TTL via <see cref="ILibraryManager"/>
/// (through <see cref="EphemeralLibraryService"/>), and prunes the in-memory release cache. Items
/// whose last-access time is unknown — e.g. orphaned by a plugin restart that lost the in-memory
/// store — are treated as expired and removed; they are cheap to re-materialize on the next search.
/// Runs hourly by default. No domain logic: it is pure lifecycle bookkeeping (BRIEF §11).
/// </summary>
public sealed class EphemeralCleanupTask(
    EphemeralLibraryService library,
    EphemeralReleaseStore store,
    ILogger<EphemeralCleanupTask> logger) : IScheduledTask
{
    public string Name => "Streamarr: clean up ephemeral items";

    public string Key => "StreamarrEphemeralCleanup";

    public string Description =>
        "Delete Usenet ephemeral items whose TTL has expired and close their lingering sessions (BRIEF §8.5).";

    public string Category => "Streamarr";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);

        var ttlMinutes = Plugin.Instance?.Configuration.EphemeralTtlMinutes ?? 0;
        if (ttlMinutes <= 0)
        {
            logger.LogDebug("Ephemeral TTL cleanup skipped (TTL disabled: {Ttl} min)", ttlMinutes);
            progress.Report(100);
            return Task.CompletedTask;
        }

        var ttl = TimeSpan.FromMinutes(ttlMinutes);
        var now = DateTime.UtcNow;

        var items = library.GetEphemeralItems();
        var deleted = 0;
        for (var i = 0; i < items.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var item = items[i];
            var lastAccessed = store.Peek(item.Id)?.LastAccessedUtc;
            if (EphemeralCleanup.IsExpired(lastAccessed, now, ttl))
            {
                try
                {
                    library.Delete(item);
                    store.Remove(item.Id);
                    deleted++;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed to delete expired ephemeral item {ItemId}", item.Id);
                }
            }

            progress.Report(items.Count == 0 ? 100 : (i + 1) * 100.0 / items.Count);
        }

        logger.LogInformation(
            "Ephemeral cleanup: deleted {Deleted} of {Total} ephemeral item(s) past a {Ttl} TTL",
            deleted, items.Count, ttl);
        progress.Report(100);
        return Task.CompletedTask;
    }

    // Hourly by default; the TTL itself (config) decides how old an item must be to go.
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() =>
    [
        new TaskTriggerInfo
        {
            Type = TaskTriggerInfo.TriggerInterval,
            IntervalTicks = TimeSpan.FromHours(1).Ticks,
        },
    ];
}

/// <summary>Pure TTL-expiry decision, split out so it is unit-testable without a Jellyfin host.</summary>
public static class EphemeralCleanup
{
    /// <summary>
    /// An item is expired when its last-access time is unknown (orphaned across a restart) or
    /// older than the TTL relative to <paramref name="nowUtc"/>.
    /// </summary>
    public static bool IsExpired(DateTime? lastAccessedUtc, DateTime nowUtc, TimeSpan ttl)
        => lastAccessedUtc is not { } last || nowUtc - last > ttl;
}
