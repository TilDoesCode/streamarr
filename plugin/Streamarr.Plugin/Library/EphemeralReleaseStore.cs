using System.Collections.Concurrent;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;
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
    public const int MaxEntries = 500;
    public const int MaxSerializedWorkBytes = 32 * 1024;
    public const int MaxPersistenceFileBytes = 20 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        MaxDepth = 16,
    };

    private readonly ConcurrentDictionary<Guid, Entry> _byItem = new();
    private readonly SemaphoreSlim _persistenceGate = new(1, 1);
    private readonly object _entryGate = new();
    private readonly string? _persistencePath;
    private readonly ILogger<EphemeralReleaseStore>? _logger;

    /// <summary>In-memory instance for isolated unit tests.</summary>
    public EphemeralReleaseStore()
    {
    }

    /// <summary>Production constructor: cache state survives a Jellyfin/plugin restart.</summary>
    public EphemeralReleaseStore(
        IApplicationPaths paths,
        ILogger<EphemeralReleaseStore> logger)
        : this(Path.Combine(paths.DataPath, "streamarr", "ephemeral-releases.json"), logger)
    {
    }

    /// <summary>File-backed instance used by persistence tests.</summary>
    public EphemeralReleaseStore(string persistencePath)
        : this(persistencePath, null)
    {
    }

    private EphemeralReleaseStore(string persistencePath, ILogger<EphemeralReleaseStore>? logger)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(persistencePath);
        _persistencePath = persistencePath;
        _logger = logger;
        Load();
    }

    public sealed record Entry(Guid ItemId, WorkDto Work)
    {
        public DateTime LastAccessedUtc { get; set; } = DateTime.UtcNow;
    }

    public void Put(Guid itemId, WorkDto work)
    {
        var boundedWork = BoundWork(work);
        lock (_entryGate)
        {
            _byItem[itemId] = new Entry(itemId, boundedWork);
            TrimToLimit();
        }
        Persist();
    }

    /// <summary>
    /// Updates a hierarchy page as one cache transaction and writes at most one persistence
    /// snapshot. The cancellation token bounds the file write used by a cold season request.
    /// </summary>
    public async Task<bool> PutRangeAsync(
        IEnumerable<KeyValuePair<Guid, WorkDto>> works,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(works);
        var bounded = new List<KeyValuePair<Guid, WorkDto>>();
        foreach (var pair in works)
        {
            cancellationToken.ThrowIfCancellationRequested();
            bounded.Add(new KeyValuePair<Guid, WorkDto>(pair.Key, BoundWork(pair.Value)));
        }

        if (bounded.Count == 0)
            return true;

        lock (_entryGate)
        {
            foreach (var pair in bounded)
                _byItem[pair.Key] = new Entry(pair.Key, pair.Value);
            TrimToLimit();
        }

        return await PersistAsync(cancellationToken).ConfigureAwait(false);
    }

    public Entry? Get(Guid itemId)
    {
        if (_byItem.TryGetValue(itemId, out var entry))
        {
            entry.LastAccessedUtc = DateTime.UtcNow;
            Persist();
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

    public bool Remove(Guid itemId)
    {
        bool removed;
        lock (_entryGate)
            removed = _byItem.TryRemove(itemId, out _);
        if (removed)
            Persist();
        return removed;
    }

    /// <summary>Removes a complete owned subtree with one persistence snapshot.</summary>
    public int RemoveRange(IEnumerable<Guid> itemIds)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        var ids = itemIds.ToHashSet();
        var removed = 0;
        lock (_entryGate)
        {
            foreach (var itemId in ids)
            {
                if (_byItem.TryRemove(itemId, out _))
                    removed++;
            }
        }

        if (removed > 0)
            Persist();
        return removed;
    }

    private void Load()
    {
        if (_persistencePath is null || !File.Exists(_persistencePath))
            return;

        try
        {
            var file = new FileInfo(_persistencePath);
            if (file.Length > MaxPersistenceFileBytes)
            {
                _logger?.LogWarning(
                    "Ignoring oversized Streamarr release cache ({Size} bytes; limit {Limit})",
                    file.Length,
                    MaxPersistenceFileBytes);
                return;
            }

            var entries = JsonSerializer.Deserialize<List<Entry>>(File.ReadAllBytes(_persistencePath), JsonOptions) ?? [];
            foreach (var entry in entries)
            {
                if (entry is not null
                    && entry.ItemId != Guid.Empty
                    && entry.Work is not null
                    && !string.IsNullOrWhiteSpace(entry.Work.WorkId))
                {
                    try
                    {
                        _byItem[entry.ItemId] = entry with { Work = BoundWork(entry.Work) };
                    }
                    catch (ArgumentException)
                    {
                        // Skip a single malformed/oversized entry without discarding valid state.
                    }
                }
            }

            TrimToLimit();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // The Jellyfin database remains authoritative for item ownership. A corrupt cache
            // therefore degrades to re-materialization, never broad deletion.
            _logger?.LogWarning(ex, "Could not restore Streamarr ephemeral release cache from {Path}", _persistencePath);
        }
    }

    private void TrimToLimit()
    {
        while (_byItem.Count > MaxEntries)
        {
            var oldest = _byItem.Values.MinBy(entry => entry.LastAccessedUtc);
            if (oldest is null || !_byItem.TryRemove(oldest.ItemId, out _))
                break;
        }
    }

    private void Persist()
    {
        if (_persistencePath is null)
            return;

        _persistenceGate.Wait();
        try
        {
            var directory = Path.GetDirectoryName(_persistencePath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            var temporaryPath = _persistencePath + ".tmp";
            var payload = SerializeSnapshot();
            if (payload is null)
                return;

            File.WriteAllBytes(temporaryPath, payload);
            File.Move(temporaryPath, _persistencePath, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger?.LogWarning(ex, "Could not persist Streamarr ephemeral release cache to {Path}", _persistencePath);
        }
        finally
        {
            _persistenceGate.Release();
        }
    }

    private async Task<bool> PersistAsync(CancellationToken cancellationToken)
    {
        if (_persistencePath is null)
            return true;

        await _persistenceGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var directory = Path.GetDirectoryName(_persistencePath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            cancellationToken.ThrowIfCancellationRequested();
            var temporaryPath = _persistencePath + ".tmp";
            var payload = SerializeSnapshot();
            if (payload is null)
                return false;

            await File.WriteAllBytesAsync(temporaryPath, payload, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(temporaryPath, _persistencePath, true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger?.LogWarning(ex, "Could not persist Streamarr ephemeral release cache to {Path}", _persistencePath);
            return false;
        }
        finally
        {
            _persistenceGate.Release();
        }
    }

    private byte[]? SerializeSnapshot()
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(_byItem.Values.ToArray(), JsonOptions);
        if (payload.Length > MaxPersistenceFileBytes)
        {
            _logger?.LogWarning(
                "Streamarr release cache exceeded its {Limit}-byte persistence limit; retaining the previous snapshot",
                MaxPersistenceFileBytes);
            return null;
        }

        return payload;
    }

    private static WorkDto BoundWork(WorkDto work)
    {
        var bounded = StreamarrPayloadBounds.Normalize(work)
                      ?? throw new ArgumentException("Work payload is malformed.", nameof(work));
        var size = JsonSerializer.SerializeToUtf8Bytes(bounded, JsonOptions).Length;
        if (size > MaxSerializedWorkBytes)
            throw new ArgumentException("Work payload exceeds the persisted entry limit.", nameof(work));
        return bounded;
    }
}
