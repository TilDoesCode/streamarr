using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Materializes ephemeral works as real, isolated Jellyfin items (BRIEF §8.3). This is a
/// pure translation of a <see cref="WorkDto"/> into a <see cref="Movie"/> or
/// <see cref="Episode"/> — it makes no domain decisions. GUIDs are derived deterministically
/// from the workId so repeated materialization updates rather than duplicates. Items live under
/// a dedicated hidden folder tagged <c>usenet-ephemeral</c> so Usenet results never pollute the
/// real library, and the TTL cleanup task (BRIEF §8.5) enumerates + deletes them by that tag.
/// </summary>
public sealed class EphemeralLibraryService(
    ILibraryManager libraryManager,
    EphemeralReleaseStore store,
    ILogger<EphemeralLibraryService> logger)
{
    public const string EphemeralTag = "usenet-ephemeral";
    public const string WorkIdProviderKey = "UsenetWorkId";
    private const string FolderName = "Streamarr (Usenet)";

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
        var folder = await EnsureFolderAsync(ct).ConfigureAwait(false);
        var itemId = ItemIdFor(work.WorkId);
        var isEpisode = IsEpisode(work);

        var existing = libraryManager.GetItemById(itemId);
        // If a repeat search flipped the media type for this workId (should never happen), drop the
        // stale item so we never hand Jellyfin a mismatched entity for a stable GUID.
        if (existing is not null && ((isEpisode && existing is not Episode) || (!isEpisode && existing is not Movie)))
        {
            libraryManager.DeleteItem(existing, new DeleteOptions { DeleteFileLocation = false });
            existing = null;
        }

        var isNew = existing is null;
        BaseItem item = existing ?? (isEpisode ? new Episode { Id = itemId } : new Movie { Id = itemId });

        item.Name = work.Title;
        item.ProductionYear = work.Year;
        item.Overview = work.Overview;
        item.ParentId = folder.Id;
        item.IsVirtualItem = false;
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

    /// <summary>
    /// All real items currently tagged <see cref="EphemeralTag"/> (folders excluded). Used by the
    /// TTL cleanup task; querying by tag also catches items orphaned by a plugin restart that lost
    /// the in-memory <see cref="EphemeralReleaseStore"/>.
    /// </summary>
    public IReadOnlyList<BaseItem> GetEphemeralItems()
        => libraryManager
            .GetItemList(new InternalItemsQuery { Recursive = true, Tags = [EphemeralTag] })
            .Where(i => i is not Folder)
            .ToList();

    /// <summary>Deletes a materialized ephemeral item (no file on disk — these are virtual).</summary>
    public void Delete(BaseItem item)
        => libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = false });

    private async Task<Folder> EnsureFolderAsync(CancellationToken ct)
    {
        var folderId = libraryManager.GetNewItemId("streamarr-ephemeral-folder", typeof(Folder));
        if (libraryManager.GetItemById(folderId) is Folder existing)
            return existing;

        var root = libraryManager.GetUserRootFolder();
        var folder = new Folder
        {
            Id = folderId,
            Name = FolderName,
            ParentId = root.Id,
            IsVirtualItem = false,
        };
        ApplyTags(folder);
        libraryManager.CreateItem(folder, root);
        await libraryManager
            .UpdateItemAsync(folder, root, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
        logger.LogInformation("Created isolated ephemeral folder {FolderId}", folderId);
        return folder;
    }

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
    }

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
