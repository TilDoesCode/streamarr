using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Materializes ephemeral works as real, isolated Jellyfin items (BRIEF §8.3). This is a
/// pure translation of a <see cref="WorkDto"/> into a <see cref="Movie"/> or
/// <see cref="Episode"/> — it makes no domain decisions. GUIDs are derived deterministically
/// from the workId so repeated materialization updates rather than duplicates. Items live under
/// a dedicated hidden folder tagged <c>usenet-ephemeral</c> so Usenet results never pollute the
/// real library. Cleanup requires the deterministic parent plus explicit ownership provider ids;
/// the human-readable tag is never an authorization signal.
/// </summary>
public sealed class EphemeralLibraryService(
    ILibraryManager libraryManager,
    EphemeralReleaseStore store,
    PlaybackSessionTracker tracker,
    PlaybackEventDispatcher dispatcher,
    IApplicationPaths applicationPaths,
    ILogger<EphemeralLibraryService> logger)
{
    public const int MaxEphemeralItems = 500;
    public const string EphemeralTag = "usenet-ephemeral";
    public const string WorkIdProviderKey = "UsenetWorkId";
    public const string OwnerProviderKey = "StreamarrOwner";
    public const string OwnerProviderValue = "6f8d5c7a-9b2e-4a1f-8c3d-2e5a7b9c0d11";
    private const string FolderName = "Streamarr (Usenet)";
    private readonly SemaphoreSlim _materializeGate = new(1, 1);

    public Guid FolderId
        => libraryManager.GetNewItemId("streamarr-ephemeral-folder", typeof(StreamarrEphemeralFolder));

    private Guid LegacyFolderId
        => libraryManager.GetNewItemId("streamarr-ephemeral-folder", typeof(Folder));

    /// <summary>Deterministic item id for a work — mirrors the plugin's stable-GUID rule.</summary>
    public Guid ItemIdFor(string workId)
        => libraryManager.GetNewItemId("streamarr-work-" + workId, typeof(Movie));

    /// <summary>
    /// Creates or refreshes the ephemeral item for a work and caches its release list.
    /// Returns the item id. Movie works become a <see cref="Movie"/>; tv works become a bare
    /// <see cref="Episode"/> (season/episode index numbers set), both under the isolated folder.
    /// </summary>
    public async Task<Guid> MaterializeAsync(WorkDto work, CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return await MaterializeCoreAsync(work, ct).ConfigureAwait(false);
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    private async Task<Guid> MaterializeCoreAsync(WorkDto work, CancellationToken ct)
    {
        var folder = await EnsureFolderAsync(ct).ConfigureAwait(false);
        var itemId = ItemIdFor(work.WorkId);
        var isEpisode = IsEpisode(work);

        var existing = libraryManager.GetItemById(itemId);
        // If a repeat search flipped the media type for this workId (should never happen), drop the
        // stale item so we never hand Jellyfin a mismatched entity for a stable GUID.
        if (existing is not null && !IsOwnedItem(existing, folder.Id))
            throw new InvalidOperationException($"Refusing to modify non-Streamarr item {itemId}.");

        // Plugin-defined item subclasses carry the direct-by-id user/library authorization check.
        // Recreate legacy plain Movie/Episode rows so they cannot bypass that check after upgrade.
        if (existing is not null
            && ((isEpisode && existing is not StreamarrEpisode)
                || (!isEpisode && existing is not StreamarrMovie)))
        {
            libraryManager.DeleteItem(existing, new DeleteOptions { DeleteFileLocation = false });
            existing = null;
        }

        var isNew = existing is null;
        EnsureCapacity(itemId, reserveIncomingSlot: isNew);

        BaseItem item = existing
                        ?? (isEpisode
                            ? new StreamarrEpisode { Id = itemId }
                            : new StreamarrMovie { Id = itemId });

        item.Name = work.Title;
        item.ProductionYear = work.Year;
        item.Overview = work.Overview;
        item.ParentId = folder.Id;
        // Virtual items are intentionally excluded from Jellyfin's Latest/recommendation
        // queries. They are surfaced only by the guarded search interceptor.
        item.IsVirtualItem = true;
        if (work.Year is { } year)
            item.PremiereDate = new DateTime(year, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        if (work.RuntimeMinutes is { } minutes && minutes > 0)
            item.RunTimeTicks = TimeSpan.FromMinutes(minutes).Ticks;
        if (isEpisode && item is Episode episode)
        {
            episode.IndexNumber = work.Episode;
            episode.ParentIndexNumber = work.Season;
        }

        ApplyProviderIds(item, work);
        ApplyTags(item);
        TryApplyPoster(item, work.PosterUrl);

        if (isNew)
        {
            libraryManager.CreateItem(item, folder);
            logger.LogInformation("Materialized ephemeral work {WorkId} as item {ItemId}", work.WorkId, itemId);
        }
        else
        {
            await libraryManager
                .UpdateItemAsync(item, folder, ItemUpdateType.MetadataEdit, ct)
                .ConfigureAwait(false);
            logger.LogDebug("Refreshed ephemeral work {WorkId} (item {ItemId})", work.WorkId, itemId);
        }

        store.Put(itemId, work);
        return itemId;
    }

    private void EnsureCapacity(Guid incomingItemId, bool reserveIncomingSlot)
    {
        var items = GetEphemeralItems();
        var maximumExistingItems = MaxEphemeralItems - (reserveIncomingSlot ? 1 : 0);
        var requiredEvictions = Math.Max(0, items.Count - maximumExistingItems);
        if (requiredEvictions == 0)
            return;

        var victims = items
            .Where(item => item.Id != incomingItemId)
            .OrderBy(item => store.Peek(item.Id)?.LastAccessedUtc
                             ?? (item.DateLastSaved != DateTime.MinValue ? item.DateLastSaved : item.DateCreated))
            .Take(requiredEvictions)
            .ToArray();
        foreach (var victim in victims)
        {
            var sessions = tracker.ForItem(victim.Id);
            if (sessions.Any(session => session.SessionToken is { } token && !dispatcher.EnqueueClose(token)))
                break;

            foreach (var session in sessions)
                tracker.Forget(session);
            Delete(victim);
            store.Remove(victim.Id);
            logger.LogInformation("Evicted oldest ephemeral item {ItemId} at the hard item limit", victim.Id);
        }

        if (GetEphemeralItems().Count > maximumExistingItems)
            throw new InvalidOperationException($"The limit of {MaxEphemeralItems} ephemeral Streamarr items was reached.");
    }

    /// <summary>
    /// All items owned by this plugin below its deterministic private folder. A tag alone is never
    /// treated as proof of ownership: users are free to use the same tag on ordinary library items.
    /// </summary>
    public IReadOnlyList<BaseItem> GetEphemeralItems()
    {
        if (libraryManager.GetItemById(FolderId) is not StreamarrEphemeralFolder folder
            || !IsOwnedFolder(folder))
        {
            return [];
        }

        return folder
            .GetRecursiveChildren()
            .Where(i => i is not Folder && IsOwnedItem(i, folder.Id))
            .ToList();
    }

    /// <summary>Deletes a materialized ephemeral item (no file on disk — these are virtual).</summary>
    public void Delete(BaseItem item)
        => libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = false });

    private async Task<Folder> EnsureFolderAsync(CancellationToken ct)
    {
        var folderId = FolderId;
        var existingItem = libraryManager.GetItemById(folderId);
        StreamarrEphemeralFolder folder;
        if (existingItem is StreamarrEphemeralFolder existing && IsOwnedFolder(existing))
        {
            folder = existing;
            if (string.IsNullOrWhiteSpace(folder.Path))
            {
                folder.Path = EnsureFolderPath();
                await libraryManager
                    .UpdateItemAsync(folder, libraryManager.RootFolder, ItemUpdateType.MetadataEdit, ct)
                    .ConfigureAwait(false);
            }
        }
        else
        {
            if (existingItem is not null)
                throw new InvalidOperationException($"Refusing to reuse non-Streamarr folder {folderId}.");

            // Keep the implementation folder out of the user's normal media-root traversal.
            // Direct item authorization is enforced by StreamarrMovie/StreamarrEpisode.
            var root = libraryManager.RootFolder;
            folder = new StreamarrEphemeralFolder
            {
                Id = folderId,
                Name = FolderName,
                ParentId = root.Id,
                Path = EnsureFolderPath(),
                IsVirtualItem = true,
            };
            ApplyOwnership(folder);
            ApplyTags(folder);
            libraryManager.CreateItem(folder, root);
            await libraryManager
                .UpdateItemAsync(folder, root, ItemUpdateType.MetadataEdit, ct)
                .ConfigureAwait(false);
            logger.LogInformation("Created isolated ephemeral folder {FolderId}", folderId);
        }

        await MigrateLegacyFolderAsync(folder, ct).ConfigureAwait(false);
        return folder;
    }

    private string EnsureFolderPath()
    {
        var path = Path.Combine(applicationPaths.DataPath, "streamarr", "ephemeral-library");
        Directory.CreateDirectory(path);
        return path;
    }

    private async Task MigrateLegacyFolderAsync(StreamarrEphemeralFolder destination, CancellationToken ct)
    {
        if (libraryManager.GetItemById(LegacyFolderId) is not Folder legacy
            || legacy.Id == destination.Id
            || !string.Equals(legacy.Name, FolderName, StringComparison.Ordinal)
            || !legacy.Tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        var legacyChildren = legacy.GetRecursiveChildren().ToArray();
        var ownedChildren = legacyChildren.Where(IsLegacyOwnedItem).ToArray();
        var migrated = 0;
        foreach (var item in ownedChildren)
        {
            item.ParentId = destination.Id;
            item.IsVirtualItem = true;
            ApplyOwnership(item);
            await libraryManager
                .UpdateItemAsync(item, destination, ItemUpdateType.MetadataEdit, ct)
                .ConfigureAwait(false);
            migrated++;
        }

        // Ownership is established by the deterministic legacy folder id plus our provider id,
        // never by a tag alone. After all children move, the obsolete visible folder is safe to remove.
        if (legacyChildren.Length == 0)
            libraryManager.DeleteItem(legacy, new DeleteOptions { DeleteFileLocation = false });
        else if (ownedChildren.Length != legacyChildren.Length)
            logger.LogWarning("Legacy Streamarr folder contains non-plugin items and was intentionally retained");
        else
            logger.LogInformation("Legacy Streamarr folder was emptied and will be removed after Jellyfin reloads it");
        logger.LogInformation("Migrated {Count} legacy Streamarr ephemeral item(s) into the private folder", migrated);
    }

    private bool IsLegacyOwnedItem(BaseItem item)
        => item.ParentId == LegacyFolderId
           && item.ProviderIds.TryGetValue(WorkIdProviderKey, out var workId)
           && !string.IsNullOrWhiteSpace(workId)
           && item.Tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase);

    private static bool IsEpisode(WorkDto work)
        => string.Equals(work.MediaType, "tv", StringComparison.OrdinalIgnoreCase)
           || string.Equals(work.MediaType, "episode", StringComparison.OrdinalIgnoreCase);

    private static void ApplyProviderIds(BaseItem item, WorkDto work)
    {
        item.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (work.TmdbId is { } tmdb)
            item.ProviderIds[MetadataProvider.Tmdb.ToString()] = tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (!string.IsNullOrWhiteSpace(work.ImdbId))
            item.ProviderIds[MetadataProvider.Imdb.ToString()] = work.ImdbId;
        item.ProviderIds[WorkIdProviderKey] = work.WorkId;
        item.ProviderIds[OwnerProviderKey] = OwnerProviderValue;
    }

    private static void ApplyOwnership(BaseItem item)
    {
        item.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        item.ProviderIds[OwnerProviderKey] = OwnerProviderValue;
    }

    internal static bool IsOwnedFolder(BaseItem item)
        => item.ProviderIds.TryGetValue(OwnerProviderKey, out var owner)
           && string.Equals(owner, OwnerProviderValue, StringComparison.Ordinal);

    internal static bool IsOwnedItem(BaseItem item, Guid folderId)
        => item.ParentId == folderId
           && IsOwnedFolder(item)
           && item.ProviderIds.TryGetValue(WorkIdProviderKey, out var workId)
           && !string.IsNullOrWhiteSpace(workId);

    private static void ApplyTags(BaseItem item)
    {
        var tags = item.Tags?.ToList() ?? [];
        if (!tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase))
            tags.Add(EphemeralTag);
        item.Tags = tags.ToArray();
    }

    private void TryApplyPoster(BaseItem item, string? posterUrl)
    {
        if (string.IsNullOrWhiteSpace(posterUrl))
            return;
        try
        {
            // Pass the TMDB poster through as a remote image so we never rely on
            // Jellyfin's own metadata fetcher for our items (BRIEF §3.2).
            item.SetImage(new ItemImageInfo { Path = posterUrl, Type = ImageType.Primary }, 0);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not attach poster for {Name}", item.Name);
        }
    }
}
