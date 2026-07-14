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
    EphemeralReleaseStore store,
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

        var items = library.GetEphemeralItems();
        var overflow = items
            .OrderBy(item => EphemeralCleanup.ResolveLastAccess(
                store.Peek(item.Id)?.LastAccessedUtc,
                item.DateLastSaved,
                item.DateCreated))
            .Take(Math.Max(0, items.Count - EphemeralLibraryService.MaxEphemeralItems))
            .Select(item => item.Id)
            .ToHashSet();
        var deleted = 0;
        for (var i = 0; i < items.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var item = items[i];
            var lastAccessed = EphemeralCleanup.ResolveLastAccess(
                store.Peek(item.Id)?.LastAccessedUtc,
                item.DateLastSaved,
                item.DateCreated);
            if (overflow.Contains(item.Id) || EphemeralCleanup.IsExpired(lastAccessed, now, ttl))
            {
                try
                {
                    foreach (var session in tracker.TakeForItem(item.Id))
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
                                "Failed to close session for expired item {ItemId} ({FailureType})",
                                item.Id,
                                ex.GetType().Name);
                        }
                    }

                    library.Delete(item);
                    store.Remove(item.Id);
                    deleted++;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
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
