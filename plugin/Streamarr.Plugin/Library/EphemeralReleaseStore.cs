using System.Collections.Concurrent;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Library;

/// <summary>
/// In-memory index of materialized ephemeral works and their ranked release lists,
/// keyed by the Jellyfin item id (a stable GUID derived from the Core Server workId).
/// The <see cref="StreamarrMediaSourceProvider"/> reads it to expose one selectable
/// "version" per release; the bootstrap path writes it. It is a cache of the server's
/// output — never a source of truth or a place for domain decisions (BRIEF §8.3, §11).
/// </summary>
public sealed class EphemeralReleaseStore
{
    private readonly ConcurrentDictionary<Guid, Entry> _byItem = new();

    public sealed record Entry(Guid ItemId, WorkDto Work)
    {
        public DateTime LastAccessedUtc { get; set; } = DateTime.UtcNow;
    }

    public void Put(Guid itemId, WorkDto work)
        => _byItem[itemId] = new Entry(itemId, work);

    public Entry? Get(Guid itemId)
    {
        if (_byItem.TryGetValue(itemId, out var entry))
        {
            entry.LastAccessedUtc = DateTime.UtcNow;
            return entry;
        }

        return null;
    }

    /// <summary>
    /// Reads an entry <b>without</b> updating <see cref="Entry.LastAccessedUtc"/>. Used by the
    /// TTL cleanup task (BRIEF §8.5), which must observe the true last-access time rather than
    /// refreshing it just by looking.
    /// </summary>
    public Entry? Peek(Guid itemId)
        => _byItem.TryGetValue(itemId, out var entry) ? entry : null;

    public IReadOnlyList<ReleaseDto> ReleasesFor(Guid itemId)
        => Get(itemId)?.Work.Releases ?? [];

    /// <summary>Locates the work that owns a release id (for event attribution).</summary>
    public Entry? FindByReleaseId(string releaseId)
        => _byItem.Values.FirstOrDefault(e =>
            e.Work.Releases.Any(r => string.Equals(r.ReleaseId, releaseId, StringComparison.Ordinal)));

    public IReadOnlyCollection<Entry> All() => _byItem.Values.ToArray();

    public bool Remove(Guid itemId) => _byItem.TryRemove(itemId, out _);
}
