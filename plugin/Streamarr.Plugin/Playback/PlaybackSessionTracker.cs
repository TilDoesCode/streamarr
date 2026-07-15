using System.Collections.Concurrent;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Tracks every alias Jellyfin may use for an opened Core session. Removing any alias removes the
/// entire attribution, preventing release-id aliases and session capabilities from accumulating.
/// </summary>
public sealed class PlaybackSessionTracker
{
    private const int MaxTrackedSessions = 512;

    public sealed record Attribution(
        Guid TrackingId,
        Guid ItemId,
        string ReleaseId,
        string? WorkId,
        string? SessionToken,
        DateTime OpenedUtc);

    private readonly ConcurrentDictionary<string, Attribution> _byAlias = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Guid, Attribution> _byTrackingId = new();
    private readonly HashSet<Guid> _deletionClaims = [];
    private readonly object _gate = new();

    public Attribution TrackSession(
        Guid itemId,
        string mediaSourceId,
        string releaseId,
        string? workId,
        string? sessionToken,
        params string?[] additionalAliases)
    {
        if (!TryTrackSession(
                itemId,
                mediaSourceId,
                releaseId,
                workId,
                sessionToken,
                out var attribution,
                additionalAliases))
        {
            throw new InvalidOperationException($"The limit of {MaxTrackedSessions} active Streamarr sessions was reached.");
        }

        return attribution;
    }

    public bool TryTrackSession(
        Guid itemId,
        string mediaSourceId,
        string releaseId,
        string? workId,
        string? sessionToken,
        out Attribution attribution,
        params string?[] additionalAliases)
        => TryTrackSession(
            itemId,
            mediaSourceId,
            releaseId,
            workId,
            sessionToken,
            canAdmit: null,
            out attribution,
            additionalAliases);

    /// <summary>
    /// Atomically revalidates an item while sharing the same lock as deletion claims and
    /// session admission. This closes the window where cleanup could delete an item after
    /// Core resolved it but before the resulting session was tracked.
    /// </summary>
    public bool TryTrackSession(
        Guid itemId,
        string mediaSourceId,
        string releaseId,
        string? workId,
        string? sessionToken,
        Func<bool>? canAdmit,
        out Attribution attribution,
        params string?[] additionalAliases)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(mediaSourceId);
        ArgumentException.ThrowIfNullOrWhiteSpace(releaseId);

        attribution = new Attribution(
            Guid.NewGuid(),
            itemId,
            releaseId,
            workId,
            sessionToken,
            DateTime.UtcNow);
        lock (_gate)
        {
            if (_byTrackingId.Count >= MaxTrackedSessions
                || _deletionClaims.Contains(itemId)
                || canAdmit is not null && !canAdmit())
                return false;

            _byTrackingId[attribution.TrackingId] = attribution;
            foreach (var alias in new string?[] { mediaSourceId, releaseId }.Concat(additionalAliases)
                         .Where(a => !string.IsNullOrWhiteSpace(a))
                         .Distinct(StringComparer.Ordinal))
            {
                _byAlias[alias!] = attribution;
            }
        }

        return true;
    }

    public Attribution? Resolve(string? mediaSourceId)
        => mediaSourceId is not null && _byAlias.TryGetValue(mediaSourceId, out var value) ? value : null;

    public Attribution? Forget(string? mediaSourceId)
    {
        var attribution = Resolve(mediaSourceId);
        if (attribution is not null)
            Forget(attribution);
        return attribution;
    }

    public void Forget(Attribution attribution)
    {
        lock (_gate)
            Remove(attribution);
    }

    public IReadOnlyList<Attribution> ForItem(Guid itemId)
        => _byTrackingId.Values.Where(a => a.ItemId == itemId).ToArray();

    public IReadOnlyList<Attribution> TakeForItem(Guid itemId)
    {
        lock (_gate)
        {
            var matches = _byTrackingId.Values.Where(a => a.ItemId == itemId).ToArray();
            foreach (var attribution in matches)
                Remove(attribution);
            return matches;
        }
    }

    public IReadOnlyCollection<Attribution> All() => _byTrackingId.Values.ToArray();

    /// <summary>
    /// Atomically prevents new session admission for an item subtree. Capacity/retyping can require
    /// an idle subtree; scheduled cleanup may claim active sessions and close them before deletion.
    /// </summary>
    public bool TryClaimItemsForDeletion(
        IEnumerable<Guid> itemIds,
        bool requireNoSessions,
        out IReadOnlyList<Attribution> sessions)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        var ids = itemIds.ToHashSet();
        lock (_gate)
        {
            var matches = _byTrackingId.Values.Where(attribution => ids.Contains(attribution.ItemId)).ToArray();
            sessions = matches;
            if (ids.Count == 0
                || ids.Any(_deletionClaims.Contains)
                || (requireNoSessions && matches.Length > 0))
            {
                return false;
            }

            _deletionClaims.UnionWith(ids);
            return true;
        }
    }

    public void ReleaseDeletionClaim(IEnumerable<Guid> itemIds)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        lock (_gate)
            _deletionClaims.ExceptWith(itemIds);
    }

    private void Remove(Attribution attribution)
    {
        ((ICollection<KeyValuePair<Guid, Attribution>>)_byTrackingId)
            .Remove(new KeyValuePair<Guid, Attribution>(attribution.TrackingId, attribution));

        foreach (var alias in _byAlias.Where(pair => pair.Value.TrackingId == attribution.TrackingId).ToArray())
        {
            ((ICollection<KeyValuePair<string, Attribution>>)_byAlias)
                .Remove(new KeyValuePair<string, Attribution>(alias.Key, alias.Value));
        }
    }
}
