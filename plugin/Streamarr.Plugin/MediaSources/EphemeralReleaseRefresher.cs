using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Keeps <see cref="EphemeralReleaseStore"/> entries from going permanently stale. Materializing
/// an item only ever writes its release list once, at browse time — the item-details page reads
/// the cache directly (<see cref="StreamarrMediaSourceProvider.GetMediaSources"/>) and never
/// re-contacts Core on its own. If Core's search improves after materialization (fixed indexer
/// bug, a release finally leaked, a Servarr profile change), an already-materialized "0 releases"
/// item stays wrong until someone happens to re-open its season page. This class re-checks Core
/// for a single stale/empty entry (called from the read path) and, via
/// <see cref="RefreshAllNowAsync"/>, for every cached entry at once (the admin "Refresh cached
/// releases now" button). No domain logic — it only decides *when* to ask Core again; ranking and
/// release selection remain entirely the server's job.
/// </summary>
public sealed class EphemeralReleaseRefresher(
    EphemeralReleaseStore store,
    StreamarrApiClient api,
    ILogger<EphemeralReleaseRefresher> logger)
{
    /// <summary>
    /// Floor between refresh *attempts* for the same item, regardless of outcome. Protects Core
    /// from being hammered by every page view of a legitimately-still-unavailable episode, and
    /// bounds retry pressure while Core is unreachable.
    /// </summary>
    internal static readonly TimeSpan MinRetryInterval = TimeSpan.FromSeconds(60);

    /// <summary>Bounds a single refresh call so a slow/unreachable Core cannot stall a page load.</summary>
    internal static readonly TimeSpan RefreshTimeout = TimeSpan.FromSeconds(5);

    private readonly ConcurrentDictionary<Guid, DateTime> _lastAttemptUtc = new();
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _gates = new();

    /// <summary>An entry with no releases is always considered stale, subject to the retry floor.</summary>
    internal static bool NeedsRefresh(EphemeralReleaseStore.Entry entry, DateTime nowUtc, TimeSpan ttl)
        => entry.Work.Releases.Count == 0 || nowUtc - entry.LastRefreshedUtc > ttl;

    /// <summary>
    /// Best-effort, non-blocking-if-busy refresh for one item, called from the read path
    /// (<see cref="StreamarrMediaSourceProvider.GetMediaSources"/>). Never throws: a failed or
    /// timed-out refresh simply leaves the previous cached value in place.
    /// </summary>
    public async Task RefreshIfStaleAsync(Guid itemId, CancellationToken ct)
    {
        var entry = store.Peek(itemId);
        if (entry is null)
            return;

        if (!NeedsRefresh(entry, DateTime.UtcNow, ConfiguredTtl()))
            return;

        await TryRefreshAsync(itemId, entry, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Unconditionally refreshes every currently cached entry (the config-page button), ignoring
    /// TTL/cooldown so an admin can force an immediate resync after a known Core-side fix.
    /// Returns how many entries Core successfully answered for (not necessarily how many had
    /// different releases afterward — a still-correct entry counts too).
    /// </summary>
    public async Task<int> RefreshAllNowAsync(CancellationToken ct)
    {
        var refreshed = 0;
        foreach (var entry in store.All())
        {
            ct.ThrowIfCancellationRequested();
            _lastAttemptUtc.TryRemove(entry.ItemId, out _);
            if (await TryRefreshAsync(entry.ItemId, entry, ct).ConfigureAwait(false))
                refreshed++;
        }

        return refreshed;
    }

    private async Task<bool> TryRefreshAsync(Guid itemId, EphemeralReleaseStore.Entry entry, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        if (_lastAttemptUtc.TryGetValue(itemId, out var last) && now - last < MinRetryInterval)
            return false;

        var gate = _gates.GetOrAdd(itemId, static _ => new SemaphoreSlim(1, 1));
        if (!await gate.WaitAsync(0, ct).ConfigureAwait(false))
            return false; // another request is already refreshing this item; don't pile on.

        try
        {
            _lastAttemptUtc[itemId] = DateTime.UtcNow;

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(RefreshTimeout);

            SearchResponse? refreshed;
            try
            {
                refreshed = await api.RefreshWorkAsync(entry.Work, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogDebug(
                    ex,
                    "Streamarr release refresh failed for item {ItemId} ({FailureType})",
                    itemId,
                    ex.GetType().Name);
                return false;
            }

            var match = refreshed?.Results.FirstOrDefault(result =>
                string.Equals(result.WorkId, entry.Work.WorkId, StringComparison.Ordinal));
            if (match is null)
                return false;

            store.Put(itemId, match);
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    private static TimeSpan ConfiguredTtl() => TimeSpan.FromMinutes(
        Plugin.Instance?.Configuration.ReleaseCacheTtlMinutes ?? 30);
}
