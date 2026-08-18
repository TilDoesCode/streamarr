using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Querying;
using Jellyfin.Data.Enums;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Materializes ephemeral works as real Jellyfin items (BRIEF §8.3). This is a
/// pure translation of a <see cref="WorkDto"/> into a <see cref="Movie"/> or
/// <see cref="Episode"/> — it makes no domain decisions. GUIDs are derived deterministically
/// from the workId so repeated materialization updates rather than duplicates. Items live under
/// a dedicated plugin folder tagged <c>usenet-ephemeral</c>. With library integration enabled
/// (default) that folder sits below the user root and surfaces as its own "Streamarr" library,
/// which integrates the items into Continue Watching, Next Up and Favorites; disabled, it sits
/// below the hidden aggregate root and the items stay fully isolated. Cleanup requires the
/// deterministic parent plus explicit ownership provider ids; the human-readable tag is never
/// an authorization signal.
/// </summary>
public sealed class EphemeralLibraryService(
    ILibraryManager libraryManager,
    EphemeralReleaseStore store,
    PlaybackSessionTracker tracker,
    IApplicationPaths applicationPaths,
    IUserManager userManager,
    IUserDataManager userDataManager,
    IProviderManager providerManager,
    IFileSystem fileSystem,
    ArtworkBadgeService artworkBadge,
    HierarchyEnrichmentDispatcher enrichment,
    ILogger<EphemeralLibraryService> logger)
{
    public const int MaxEphemeralItems = 500;
    public const string EphemeralTag = "usenet-ephemeral";
    public const string StreamarrTag = "streamarr";
    public const string WorkIdProviderKey = "UsenetWorkId";
    public const string OwnerProviderKey = "StreamarrOwner";
    public const string OwnerProviderValue = "6f8d5c7a-9b2e-4a1f-8c3d-2e5a7b9c0d11";
    public const string ExpectedChildCountProviderKey = "StreamarrExpectedChildCount";
    public const string CatalogChildCountProviderKey = "StreamarrCatalogChildCount";
    private const string FolderName = "Streamarr";
    private const string LegacyFolderName = "Streamarr (Usenet)";
    private const string StagingFolderName = "Streamarr Search";

    /// <summary>
    /// Serializes every materialization plugin-wide (there is deliberately no per-work/per-user
    /// scoping: capacity eviction reasons over every ephemeral item at once and needs a single
    /// consistent view). Code holding this gate never awaits artwork network I/O: hierarchy
    /// shells are committed with remote image URLs, then a bounded background worker badges
    /// artwork and attaches people metadata after the client response has been released.
    /// </summary>
    private readonly SemaphoreSlim _materializeGate = new(1, 1);
    private readonly object _hierarchyProtectionSync = new();
    private readonly Dictionary<Guid, int> _seriesHierarchyReservations = new();

    public Guid FolderId
        => libraryManager.GetNewItemId("streamarr-ephemeral-folder", typeof(StreamarrEphemeralFolder));

    /// <summary>
    /// The hidden staging root below the aggregate root. Every search hit materializes here first
    /// and stays out of all user views; a subtree only moves below <see cref="FolderId"/> (the
    /// visible "Streamarr" library) once a user deliberately engages with it (playback start,
    /// favorite, or watched state). See <see cref="TryPromoteToLibraryAsync"/>.
    /// </summary>
    public Guid StagingFolderId
        => libraryManager.GetNewItemId("streamarr-ephemeral-staging-folder", typeof(StreamarrEphemeralFolder));

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
        Guid itemId;
        try
        {
            itemId = await MaterializeCoreAsync(work, work.PosterUrl, ct, applyPeople: false)
                .ConfigureAwait(false);
        }
        finally
        {
            _materializeGate.Release();
        }
        enrichment.Enqueue("work:" + work.WorkId, token => EnrichWorkAsync(work, token));
        return itemId;
    }

    /// <summary>Materializes one series shell; no season or indexer request occurs here.</summary>
    public async Task<Guid> MaterializeSeriesAsync(TvSeriesDto series, CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        Guid itemId;
        try
        {
            itemId = await MaterializeSeriesCoreAsync(series, series.PosterUrl, ct, applyPeople: false)
                .ConfigureAwait(false);
        }
        finally
        {
            _materializeGate.Release();
        }
        enrichment.Enqueue("series:" + series.WorkId, token => EnrichSeriesAsync(series, token));
        return itemId;
    }

    /// <summary>Materializes the lightweight season directory returned when a series opens.</summary>
    public async Task<IReadOnlyList<Guid>> MaterializeSeasonsAsync(
        TvSeriesDetailsResponse details,
        CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        IReadOnlyList<Guid> result;
        try
        {
            var seriesId = await MaterializeSeriesCoreAsync(
                    details.Series,
                    details.Series.PosterUrl,
                    ct,
                    applyPeople: false)
                .ConfigureAwait(false);
            if (libraryManager.GetItemById(seriesId) is not Series parent)
                throw new InvalidOperationException($"The Streamarr series parent {seriesId} is missing.");
            await ClearHierarchyCompletionAsync(parent, ct).ConfigureAwait(false);

            var ids = new List<Guid>(details.Seasons.Count);
            var creates = new List<BaseItem>();
            var updates = new List<BaseItem>();
            var retiredStoreIds = new List<Guid>();
            foreach (var season in details.Seasons)
            {
                ct.ThrowIfCancellationRequested();
                var itemId = ItemIdFor(season.WorkId);
                if (ids.Contains(itemId))
                    continue;

                ids.Add(itemId);
                var existing = libraryManager.GetItemById(itemId);
                ValidateHierarchyOwnership(existing, parent.Id, season.WorkId, itemId);
                if (existing is not null && existing is not Season)
                {
                    DeleteForRetype(existing, removeReleaseState: false);
                    retiredStoreIds.Add(itemId);
                    existing = null;
                }

                var item = existing as Season ?? new Season { Id = itemId };
                PopulateSeason(item, season, parent, season.PosterUrl);
                (existing is null ? creates : updates).Add(item);
            }

            await RemoveStaleDirectChildrenAsync(parent.Id, BaseItemKind.Season, ids.ToHashSet(), ct)
                .ConfigureAwait(false);
            store.RemoveRange(retiredStoreIds);
            // Children created inside an already-promoted series belong to the history and do not
            // consume ephemeral capacity.
            var incomingSlots = parent.ParentId == FolderId ? 0 : creates.Count;
            await EnsureCapacityAsync(ids.Append(seriesId).ToHashSet(), incomingSlots, ct).ConfigureAwait(false);
            SaveBatch(creates, parent, ct);
            await UpdateBatchAsync(updates, parent, ct).ConfigureAwait(false);
            await MarkHierarchyCompleteAsync(parent, ids.Count, ct).ConfigureAwait(false);
            result = ids;
        }
        finally
        {
            _materializeGate.Release();
        }
        enrichment.Enqueue(
            "seasons:" + details.Series.WorkId,
            token => EnrichSeasonsAsync(details, token));
        return result;
    }

    /// <summary>
    /// Materializes every canonical episode in one opened season and stores any ranked release
    /// offers Core attached. Episodes with no release deliberately remain navigable but unplayable.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> MaterializeEpisodesAsync(
        TvSeasonDetailsResponse details,
        CancellationToken ct,
        bool protectSeriesHierarchy = false)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        IReadOnlyList<Guid> result;
        try
        {
            var seriesId = await MaterializeSeriesCoreAsync(
                    details.Series,
                    details.Series.PosterUrl,
                    ct,
                    applyPeople: false)
                .ConfigureAwait(false);
            var seasonId = await MaterializeSeasonCoreAsync(
                    details.Season,
                    seriesId,
                    details.Season.PosterUrl,
                    ct)
                .ConfigureAwait(false);
            if (libraryManager.GetItemById(seriesId) is not Series seriesParent)
                throw new InvalidOperationException($"The Streamarr series parent {seriesId} is missing.");
            if (libraryManager.GetItemById(seasonId) is not Season seasonParent)
                throw new InvalidOperationException($"The Streamarr season parent {seasonId} is missing.");
            await ClearHierarchyCompletionAsync(seasonParent, ct).ConfigureAwait(false);

            var ids = new List<Guid>(details.Episodes.Count);
            var creates = new List<BaseItem>();
            var updates = new List<BaseItem>();
            var retiredStoreIds = new List<Guid>();
            var works = new List<KeyValuePair<Guid, WorkDto>>(details.Episodes.Count);
            foreach (var episode in details.Episodes)
            {
                ct.ThrowIfCancellationRequested();
                var itemId = ItemIdFor(episode.WorkId);
                if (ids.Contains(itemId))
                    continue;

                ids.Add(itemId);
                var existing = libraryManager.GetItemById(itemId);
                ValidateHierarchyOwnership(existing, seasonParent.Id, episode.WorkId, itemId);
                if (existing is not null && existing is not Episode)
                {
                    DeleteForRetype(existing, removeReleaseState: false);
                    retiredStoreIds.Add(itemId);
                    existing = null;
                }

                var item = existing as Episode ?? new Episode { Id = itemId };
                PopulateEpisode(
                    item,
                    episode,
                    seriesParent,
                    seasonParent,
                    details.Series,
                    episode.StillUrl);
                (existing is null ? creates : updates).Add(item);
                works.Add(new KeyValuePair<Guid, WorkDto>(itemId, episode.ToWork()));
            }

            await RemoveStaleDirectChildrenAsync(seasonParent.Id, BaseItemKind.Episode, ids.ToHashSet(), ct)
                .ConfigureAwait(false);
            store.RemoveRange(retiredStoreIds);
            await EnsureCapacityAsync(
                    ids.Append(seriesId).Append(seasonId).ToHashSet(),
                    seriesParent.ParentId == FolderId ? 0 : creates.Count,
                    ct,
                    protectDescendantsOfProtectedItems: protectSeriesHierarchy)
                .ConfigureAwait(false);
            SaveBatch(creates, seasonParent, ct);
            await UpdateBatchAsync(updates, seasonParent, ct).ConfigureAwait(false);
            if (!await store.PutRangeAsync(works, ct).ConfigureAwait(false))
                throw new IOException("Could not persist the Streamarr episode release cache.");
            await MarkHierarchyCompleteAsync(seasonParent, ids.Count, ct).ConfigureAwait(false);
            result = ids;
        }
        finally
        {
            _materializeGate.Release();
        }
        enrichment.Enqueue(
            "episodes:" + details.Season.WorkId,
            token => EnrichEpisodesAsync(details, token));
        return result;
    }

    public bool TryGetOwnedSeries(Guid itemId, out Series? series, out int tmdbId)
    {
        series = libraryManager.GetItemById(itemId) as Series;
        tmdbId = 0;
        return series is not null
               && (IsOwnedItem(series, FolderId) || IsOwnedItem(series, StagingFolderId))
               && TryTmdbId(series, out tmdbId);
    }

    public bool TryGetOwnedSeason(
        Guid itemId,
        out Season? season,
        out Series? series,
        out int tmdbId,
        out int seasonNumber)
    {
        season = libraryManager.GetItemById(itemId) as Season;
        series = null;
        tmdbId = 0;
        seasonNumber = -1;
        if (season is null
            || season.ParentId == Guid.Empty
            || season.IndexNumber is not int number
            || number < 0
            || !TryGetOwnedSeries(season.ParentId, out series, out tmdbId)
            || !IsOwnedItem(season, series!.Id))
        {
            return false;
        }

        seasonNumber = number;
        return true;
    }

    public bool TryFindOwnedSeason(Guid seriesId, int seasonNumber, out Season? season)
    {
        season = null;
        if (seasonNumber < 0 || !TryGetOwnedSeries(seriesId, out var series, out _) || series is null)
            return false;

        season = GetEphemeralItems()
            .OfType<Season>()
            .FirstOrDefault(item => item.ParentId == seriesId
                                    && item.IndexNumber == seasonNumber
                                    && IsOwnedItem(item, seriesId));
        return season is not null;
    }

    public IReadOnlyList<Season> GetOwnedSeasons(Guid seriesId)
    {
        if (!TryGetOwnedSeries(seriesId, out var series, out _) || series is null)
            return [];

        return GetEphemeralItems()
            .OfType<Season>()
            .Where(item => item.ParentId == seriesId && IsOwnedItem(item, seriesId))
            .OrderBy(item => item.IndexNumber)
            .ToList();
    }

    public IReadOnlyList<Episode> GetOwnedEpisodes(Guid seasonId)
    {
        if (!TryGetOwnedSeason(seasonId, out var season, out _, out _, out _)
            || season is null)
        {
            return [];
        }

        return GetEphemeralItems()
            .OfType<Episode>()
            .Where(item => item.ParentId == seasonId
                           && item.SeasonId == seasonId
                           && item.SeriesId == season.SeriesId
                           && IsOwnedItem(item, seasonId))
            .OrderBy(item => item.ParentIndexNumber)
            .ThenBy(item => item.IndexNumber)
            .ToList();
    }

    /// <summary>
    /// Prevents capacity eviction and scheduled cleanup from deleting any part of a series while
    /// a recursive query snapshots and fills its seasons. Ref-counting permits overlapping queries.
    /// </summary>
    public IDisposable ReserveSeriesHierarchy(Guid seriesId)
    {
        if (seriesId == Guid.Empty)
            throw new ArgumentException("A series id is required.", nameof(seriesId));

        lock (_hierarchyProtectionSync)
        {
            _seriesHierarchyReservations[seriesId] =
                _seriesHierarchyReservations.GetValueOrDefault(seriesId) + 1;
        }

        return new SeriesHierarchyReservation(this, seriesId);
    }

    private void ReleaseSeriesHierarchy(Guid seriesId)
    {
        lock (_hierarchyProtectionSync)
        {
            if (!_seriesHierarchyReservations.TryGetValue(seriesId, out var count))
                return;
            if (count <= 1)
                _seriesHierarchyReservations.Remove(seriesId);
            else
                _seriesHierarchyReservations[seriesId] = count - 1;
        }
    }

    public bool CanExpandCompleteSeriesHierarchy(Guid seriesId)
    {
        var seasons = GetOwnedSeasons(seriesId);
        var episodeCounts = new List<int>(seasons.Count);
        foreach (var season in seasons)
        {
            if (!season.ProviderIds.TryGetValue(CatalogChildCountProviderKey, out var value)
                || !int.TryParse(
                    value,
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var count)
                || count < 0)
            {
                return false;
            }

            episodeCounts.Add(count);
        }

        return ProjectedSeriesHierarchyItemCount(episodeCounts) <= MaxEphemeralItems;
    }

    internal static long ProjectedSeriesHierarchyItemCount(IEnumerable<int> episodeCounts)
    {
        ArgumentNullException.ThrowIfNull(episodeCounts);
        long seasons = 0;
        long episodes = 0;
        foreach (var count in episodeCounts)
        {
            if (count < 0)
                return long.MaxValue;
            seasons++;
            episodes += count;
        }

        return 1 + seasons + episodes;
    }

    /// <summary>
    /// Creates or updates the series shell without performing artwork network I/O.
    /// </summary>
    private async Task<Guid> MaterializeSeriesCoreAsync(
        TvSeriesDto series,
        string? primaryImage,
        CancellationToken ct,
        bool applyPeople = true)
    {
        var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
        var itemId = ItemIdFor(series.WorkId);
        var existing = libraryManager.GetItemById(itemId);
        ValidateHierarchyOwnership(existing, roots.Staging.Id, series.WorkId, itemId);
        if (existing is not null && existing is not Series)
        {
            DeleteForRetype(existing, removeReleaseState: true);
            existing = null;
        }

        var isNew = existing is null;
        // See MaterializeCoreAsync: new series stage hidden, promoted ones stay in the library.
        Folder folder = existing is not null && existing.ParentId == roots.Library.Id
            ? roots.Library
            : roots.Staging;
        await EnsureCapacityAsync(new HashSet<Guid> { itemId }, isNew ? 1 : 0, ct).ConfigureAwait(false);
        var item = existing as Series ?? new Series { Id = itemId };
        PopulateSeries(item, series, folder.Id, primaryImage);
        await SaveAsync(item, folder, isNew, ct).ConfigureAwait(false);
        if (applyPeople)
            await ApplyPeopleAsync(item, series.People, ct).ConfigureAwait(false);
        return itemId;
    }

    /// <summary>
    /// Creates or updates one season without performing artwork network I/O.
    /// </summary>
    private async Task<Guid> MaterializeSeasonCoreAsync(
        TvSeasonDto season,
        Guid seriesId,
        string? primaryImage,
        CancellationToken ct)
    {
        if (libraryManager.GetItemById(seriesId) is not Series parent)
            throw new InvalidOperationException($"The Streamarr series parent {seriesId} is missing.");

        var itemId = ItemIdFor(season.WorkId);
        var existing = libraryManager.GetItemById(itemId);
        ValidateHierarchyOwnership(existing, parent.Id, season.WorkId, itemId);
        if (existing is not null && existing is not Season)
        {
            DeleteForRetype(existing, removeReleaseState: true);
            existing = null;
        }

        var isNew = existing is null;
        var incomingSlots = isNew && parent.ParentId != FolderId ? 1 : 0;
        await EnsureCapacityAsync(new HashSet<Guid> { seriesId, itemId }, incomingSlots, ct).ConfigureAwait(false);
        var item = existing as Season ?? new Season { Id = itemId };
        PopulateSeason(item, season, parent, primaryImage);
        await SaveAsync(item, parent, isNew, ct).ConfigureAwait(false);
        return itemId;
    }

    private void PopulateEpisode(
        Episode item,
        TvEpisodeDto episode,
        Series series,
        Season season,
        TvSeriesDto seriesMetadata,
        string? primaryImage)
    {
        item.Name = episode.Title;
        item.Overview = episode.Overview;
        item.ParentId = season.Id;
        item.SeriesId = series.Id;
        item.SeasonId = season.Id;
        item.SeriesName = series.Name;
        item.SeasonName = season.Name;
        item.SeriesPresentationUniqueKey = series.GetPresentationUniqueKey();
        item.IndexNumber = episode.EpisodeNumber;
        item.ParentIndexNumber = episode.SeasonNumber;
        // These are real catalog entries backed by the plugin media-source provider. Marking them
        // virtual makes Jellyfin's native isMissing=false episode queries remove them.
        item.IsVirtualItem = false;
        ApplyMetadata(item, episode.CommunityRating, originalTitle: null, tagline: null,
            officialRating: null, genres: [], studios: [], productionLocations: [], trailerUrl: null);
        ApplyAirDate(item, episode.AirDate);
        if (episode.RuntimeMinutes is { } minutes && minutes > 0)
            item.RunTimeTicks = TimeSpan.FromMinutes(minutes).Ticks;
        ApplyProviderIds(item, episode.WorkId, episode.TmdbId, seriesMetadata.ImdbId);
        // NULL keys collapse into one group in Jellyfin's recursive de-duplication queries.
        item.PresentationUniqueKey = item.CreatePresentationUniqueKey();
        ApplyTags(item);
        TryApplyImage(item, primaryImage, ImageType.Primary);
    }

    private void PopulateSeason(
        Season item,
        TvSeasonDto season,
        Series series,
        string? primaryImage)
    {
        item.Name = season.Title;
        item.Overview = season.Overview;
        item.ParentId = series.Id;
        item.SeriesId = series.Id;
        item.SeriesName = series.Name;
        // Jellyfin's Series.GetSeasons query joins on this key, not ParentId/SeriesId.
        item.SeriesPresentationUniqueKey = series.GetPresentationUniqueKey();
        item.IndexNumber = season.SeasonNumber;
        item.IsVirtualItem = false;
        item.PresentationUniqueKey = item.CreatePresentationUniqueKey();
        ApplyAirDate(item, season.AirDate);
        ApplyProviderIds(item, season.WorkId, season.TmdbId, imdbId: null);
        item.ProviderIds[CatalogChildCountProviderKey] = season.EpisodeCount.ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        ApplyTags(item);
        TryApplyImage(item, primaryImage, ImageType.Primary);
    }

    private void PopulateSeries(
        Series item,
        TvSeriesDto series,
        Guid folderId,
        string? primaryImage)
    {
        item.Name = series.Title;
        item.ProductionYear = series.Year;
        item.Overview = series.Overview;
        item.ParentId = folderId;
        // Non-virtual so the series participates in Next Up's series queries and in library
        // browsing (recursive folder queries default to IsVirtualItem=false).
        item.IsVirtualItem = false;
        ApplyMetadata(
            item,
            series.CommunityRating,
            series.OriginalTitle,
            series.Tagline,
            series.OfficialRating,
            series.Genres,
            series.Studios,
            series.ProductionLocations,
            series.TrailerUrl);
        if (series.Year is { } year)
            item.PremiereDate = new DateTime(year, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        if (series.RuntimeMinutes is { } minutes && minutes > 0)
            item.RunTimeTicks = TimeSpan.FromMinutes(minutes).Ticks;
        ApplyProviderIds(item, series.WorkId, series.TmdbId, series.ImdbId);
        // Native season/episode queries are keyed through the persisted presentation key.
        item.PresentationUniqueKey = item.CreatePresentationUniqueKey();
        ApplyTags(item);
        TryApplyImage(item, primaryImage, ImageType.Primary);
        TryApplyImage(item, series.BackdropUrl, ImageType.Backdrop);
        TryApplyImage(item, series.BackdropUrl, ImageType.Thumb);
    }

    private async Task SaveAsync(BaseItem item, BaseItem parent, bool isNew, CancellationToken ct)
    {
        if (isNew)
        {
            SaveBatch([item], parent, ct);
            logger.LogInformation("Materialized ephemeral hierarchy item {WorkId} as {ItemId}",
                item.ProviderIds.GetValueOrDefault(WorkIdProviderKey), item.Id);
            return;
        }

        await libraryManager
            .UpdateItemAsync(item, parent, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
    }

    private void SaveBatch(IReadOnlyList<BaseItem> items, BaseItem parent, CancellationToken ct)
    {
        if (items.Count == 0)
            return;
        ct.ThrowIfCancellationRequested();
        libraryManager.CreateItems(items, parent, ct);
        ct.ThrowIfCancellationRequested();
        logger.LogInformation("Materialized {Count} ephemeral hierarchy item(s) below {ParentId}", items.Count, parent.Id);
    }

    private async Task UpdateBatchAsync(IReadOnlyList<BaseItem> items, BaseItem parent, CancellationToken ct)
    {
        if (items.Count == 0)
            return;
        ct.ThrowIfCancellationRequested();
        await libraryManager
            .UpdateItemsAsync(items, parent, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
    }

    private async Task MarkHierarchyCompleteAsync(BaseItem parent, int expectedChildCount, CancellationToken ct)
    {
        if (libraryManager.GetItemById(parent.ParentId) is not { } container)
            throw new InvalidOperationException($"The Streamarr hierarchy container {parent.ParentId} is missing.");

        parent.ProviderIds[ExpectedChildCountProviderKey] = expectedChildCount.ToString(
            System.Globalization.CultureInfo.InvariantCulture);
        await libraryManager
            .UpdateItemAsync(parent, container, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
    }

    private async Task ClearHierarchyCompletionAsync(BaseItem parent, CancellationToken ct)
    {
        if (!parent.ProviderIds.ContainsKey(ExpectedChildCountProviderKey))
            return;

        await InvalidateHierarchyCompletionAsync(parent.Id, ct).ConfigureAwait(false);
    }

    private async Task InvalidateHierarchyCompletionAsync(Guid parentId, CancellationToken ct)
    {
        if (libraryManager.GetItemById(parentId) is not { } parent
            || !parent.ProviderIds.Remove(ExpectedChildCountProviderKey))
        {
            return;
        }
        if (libraryManager.GetItemById(parent.ParentId) is not { } container)
            throw new InvalidOperationException($"The Streamarr hierarchy container {parent.ParentId} is missing.");

        await libraryManager
            .UpdateItemAsync(parent, container, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
    }

    private async Task RemoveStaleDirectChildrenAsync(
        Guid parentId,
        BaseItemKind childKind,
        IReadOnlySet<Guid> authoritativeIds,
        CancellationToken ct)
    {
        var stale = SelectStaleDirectChildren(
            GetEphemeralItems(),
            parentId,
            childKind,
            authoritativeIds);
        if (stale.Count == 0)
            return;

        await InvalidateHierarchyCompletionAsync(parentId, ct).ConfigureAwait(false);
        var removedIds = new HashSet<Guid>();
        try
        {
            foreach (var item in stale)
            {
                var subtree = GetLifecycleItems()
                    .FirstOrDefault(candidate => candidate.Item.Id == item.Id);
                var subtreeIds = subtree?.SubtreeIds ?? new HashSet<Guid> { item.Id };
                if (!tracker.TryClaimItemsForDeletion(
                        subtreeIds,
                        requireNoSessions: true,
                        out _))
                {
                    throw new InvalidOperationException(
                        $"Could not retire stale Streamarr hierarchy item {item.Id}.");
                }

                try
                {
                    removedIds.UnionWith(DeleteTreeCore(item, removeReleaseState: false));
                }
                finally
                {
                    tracker.ReleaseDeletionClaim(subtreeIds);
                }
            }
        }
        finally
        {
            store.RemoveRange(removedIds);
        }
    }

    /// <summary>
    /// Creates or updates one movie/episode work without performing artwork network I/O.
    /// </summary>
    private async Task<Guid> MaterializeCoreAsync(
        WorkDto work,
        string? primaryImage,
        CancellationToken ct,
        bool applyPeople = true)
    {
        var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
        var itemId = ItemIdFor(work.WorkId);
        var isEpisode = IsEpisode(work);

        var existing = libraryManager.GetItemById(itemId);
        // If a repeat search flipped the media type for this workId (should never happen), drop the
        // stale item so we never hand Jellyfin a mismatched entity for a stable GUID.
        if (existing is not null
            && (!IsOwnedRootChild(existing, roots) || !HasWorkId(existing, work.WorkId)))
        {
            throw new InvalidOperationException($"Refusing to modify non-Streamarr item {itemId}.");
        }

        // Plugin-defined item subclasses carry the direct-by-id user/library authorization check.
        // Recreate legacy plain Movie/Episode rows so they cannot bypass that check after upgrade.
        if (existing is not null
            && ((isEpisode && existing is not Episode)
                || (!isEpisode && existing is not Movie)))
        {
            DeleteForRetype(existing, removeReleaseState: true);
            existing = null;
        }

        var isNew = existing is null;
        // New search hits stage hidden below the aggregate root; an already-promoted item is
        // refreshed in place so the engaged history never loses its placement to a repeat search.
        Folder folder = existing is not null && existing.ParentId == roots.Library.Id
            ? roots.Library
            : roots.Staging;
        await EnsureCapacityAsync(new HashSet<Guid> { itemId }, isNew ? 1 : 0, ct).ConfigureAwait(false);

        BaseItem item = existing
                        ?? (isEpisode
                            ? new Episode { Id = itemId }
                            : new Movie { Id = itemId });

        item.Name = work.Title;
        item.ProductionYear = work.Year;
        item.Overview = work.Overview;
        item.ParentId = folder.Id;
        // These are real catalog entries backed by the plugin media-source provider. Jellyfin's
        // resume ("Continue Watching") endpoint filters IsVirtualItem=false twice (controller and
        // repository), so virtual items can never resume. Isolation from user views is achieved
        // through folder placement, not through the virtual flag.
        item.IsVirtualItem = false;
        ApplyMetadata(
            item,
            work.CommunityRating,
            work.OriginalTitle,
            work.Tagline,
            work.OfficialRating,
            work.Genres,
            work.Studios,
            work.ProductionLocations,
            work.TrailerUrl);
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
        // Jellyfin's recursive user queries de-duplicate by PresentationUniqueKey; rows with a
        // NULL key all collapse into one group and vanish. Every materialized row needs one.
        item.PresentationUniqueKey = item.CreatePresentationUniqueKey();
        ApplyTags(item);
        TryApplyImage(item, primaryImage, ImageType.Primary);
        TryApplyImage(item, work.BackdropUrl, ImageType.Backdrop);

        if (isNew)
        {
            SaveBatch([item], folder, ct);
            logger.LogInformation("Materialized ephemeral work {WorkId} as item {ItemId}", work.WorkId, itemId);
        }
        else
        {
            await libraryManager
                .UpdateItemAsync(item, folder, ItemUpdateType.MetadataEdit, ct)
                .ConfigureAwait(false);
            logger.LogDebug("Refreshed ephemeral work {WorkId} (item {ItemId})", work.WorkId, itemId);
        }

        if (applyPeople)
            await ApplyPeopleAsync(item, work.People, ct).ConfigureAwait(false);
        store.Put(itemId, work);
        return itemId;
    }

    private async Task EnsureCapacityAsync(
        IReadOnlySet<Guid> protectedItemIds,
        int incomingSlots,
        CancellationToken ct,
        bool protectDescendantsOfProtectedItems = false)
    {
        if (incomingSlots < 0 || incomingSlots > MaxEphemeralItems)
            throw new InvalidOperationException($"The limit of {MaxEphemeralItems} ephemeral Streamarr items was reached.");

        if (incomingSlots == 0)
            return;

        var maximumExistingItems = MaxEphemeralItems - incomingSlots;
        var blocked = new HashSet<Guid>();
        var evictedIds = new HashSet<Guid>();
        var capacitySatisfied = false;
        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var items = GetEphemeralItems();
                if (CountDescendants(items, StagingFolderId) <= maximumExistingItems)
                {
                    capacitySatisfied = true;
                    break;
                }

                var lifecycle = BuildLifecycleItems(items);
                var remainingIds = lifecycle
                    .Where(candidate => !candidate.IsPromoted)
                    .Select(candidate => candidate.Item.Id)
                    .ToHashSet();
                var slotsToFree = remainingIds.Count - maximumExistingItems;
                IReadOnlySet<Guid> reservedSeriesIds;
                lock (_hierarchyProtectionSync)
                    reservedSeriesIds = _seriesHierarchyReservations.Keys.ToHashSet();
                var protectedHierarchyIds = SelectProtectedHierarchyIds(
                    lifecycle,
                    protectedItemIds,
                    protectDescendantsOfProtectedItems,
                    reservedSeriesIds);
                var claimed = new List<LifecycleItem>();
                var claimedIds = new HashSet<Guid>();
                foreach (var candidate in EphemeralLifecycle.OrderForDeletion(lifecycle))
                {
                    if (candidate.IsPromoted
                        || blocked.Contains(candidate.Item.Id)
                        || protectedHierarchyIds.Contains(candidate.Item.Id)
                        || candidate.SubtreeIds.Any(protectedItemIds.Contains)
                        || candidate.SubtreeIds.Any(claimedIds.Contains))
                    {
                        continue;
                    }

                    if (!tracker.TryClaimItemsForDeletion(
                            candidate.SubtreeIds,
                            requireNoSessions: true,
                            out _))
                    {
                        blocked.UnionWith(candidate.SubtreeIds);
                        continue;
                    }

                    claimed.Add(candidate);
                    claimedIds.UnionWith(candidate.SubtreeIds);
                    if (claimedIds.Count >= slotsToFree)
                        break;
                }

                if (claimed.Count == 0)
                    break;

                try
                {
                    foreach (var parentId in claimed.Select(candidate => candidate.Item.ParentId).Distinct())
                        await InvalidateHierarchyCompletionAsync(parentId, ct).ConfigureAwait(false);

                    lock (_hierarchyProtectionSync)
                    {
                        var reservedProtection = SelectProtectedHierarchyIds(
                            lifecycle,
                            protectedItemIds,
                            protectDescendantsOfProtectedItems,
                            _seriesHierarchyReservations.Keys.ToHashSet());

                        foreach (var candidate in claimed)
                        {
                            if (remainingIds.Count <= maximumExistingItems)
                                break;
                            if (reservedProtection.Contains(candidate.Item.Id)
                                || candidate.SubtreeIds.Any(protectedItemIds.Contains)
                                || candidate.SubtreeIds.Any(id => !remainingIds.Contains(id)))
                            {
                                blocked.Add(candidate.Item.Id);
                                continue;
                            }

                            var current = libraryManager.GetItemById(candidate.Item.Id);
                            if (current is null
                                || current.ParentId != candidate.Item.ParentId
                                || !current.ProviderIds.TryGetValue(WorkIdProviderKey, out var currentWorkId)
                                || !candidate.Item.ProviderIds.TryGetValue(WorkIdProviderKey, out var expectedWorkId)
                                || !string.Equals(currentWorkId, expectedWorkId, StringComparison.Ordinal))
                            {
                                blocked.Add(candidate.Item.Id);
                                continue;
                            }

                            var deleted = DeleteTreeCore(
                                current,
                                removeReleaseState: false,
                                candidate.SubtreeIds);
                            evictedIds.UnionWith(deleted);
                            remainingIds.ExceptWith(deleted);
                            logger.LogInformation(
                                "Evicted ephemeral subtree {ItemId} ({Count} item(s)) at the hard item limit",
                                candidate.Item.Id,
                                deleted.Count);
                        }
                    }

                    if (remainingIds.Count <= maximumExistingItems)
                    {
                        capacitySatisfied = true;
                        break;
                    }
                }
                finally
                {
                    foreach (var candidate in claimed)
                        tracker.ReleaseDeletionClaim(candidate.SubtreeIds);
                }
            }
        }
        finally
        {
            // Capacity may evict many leaf episodes. Persist that cache mutation once rather than
            // serializing the complete release store after every victim.
            store.RemoveRange(evictedIds);
        }

        if (!capacitySatisfied)
            throw new InvalidOperationException($"The limit of {MaxEphemeralItems} ephemeral Streamarr items was reached.");
    }

    internal static IReadOnlySet<Guid> SelectProtectedHierarchyIds(
        IReadOnlyCollection<LifecycleItem> lifecycle,
        IReadOnlySet<Guid> protectedItemIds,
        bool protectDescendantsOfProtectedItems,
        IReadOnlySet<Guid> reservedSeriesIds)
    {
        var protectedRoots = new HashSet<Guid>(reservedSeriesIds);
        if (protectDescendantsOfProtectedItems)
            protectedRoots.UnionWith(protectedItemIds);

        return lifecycle
            .Where(candidate => protectedRoots.Contains(candidate.Item.Id))
            .SelectMany(candidate => candidate.SubtreeIds)
            .ToHashSet();
    }

    public sealed record LifecycleItem(
        BaseItem Item,
        IReadOnlySet<Guid> SubtreeIds,
        DateTime? EffectiveLastAccessUtc,
        bool IsEngaged,
        bool IsPromoted);

    /// <summary>
    /// Returns hierarchy-aware lifecycle units. An ancestor's effective access is the newest
    /// access in its complete subtree, so a recently played episode protects its season/series.
    /// A subtree is "engaged" when any user holds meaningful playback state on any of its items
    /// (resume position, favorite flag, or watched state), or when the item is itself the Next Up
    /// episode following an engaged one (<see cref="EphemeralLifecycle.ResolveNextUpProtectedIds"/>) —
    /// nobody has to have touched that episode individually for Jellyfin to be showing it in Next
    /// Up. Engaged subtrees never expire by TTL and are evicted last under capacity pressure —
    /// deleting them would silently wipe the user's Continue Watching entry, favorite, or Next Up
    /// row.
    /// </summary>
    public IReadOnlyList<LifecycleItem> GetLifecycleItems()
        => BuildLifecycleItems(GetEphemeralItems());

    private IReadOnlyList<LifecycleItem> BuildLifecycleItems(IReadOnlyList<BaseItem> items)
    {
        var byId = items.ToDictionary(item => item.Id);
        var libraryFolderId = FolderId;
        return EphemeralLifecycle.Build(items.Select(item =>
            {
                var (isEngaged, lastPlayedUtc) = ResolveEngagement(item);
                var (seriesId, seasonNumber, episodeNumber) = item is Episode episode
                    ? (episode.SeriesId, episode.ParentIndexNumber, episode.IndexNumber)
                    : ((Guid?)null, (int?)null, (int?)null);
                return new EphemeralLifecycle.Node(
                    item.Id,
                    item.ParentId,
                    ResolveOwnLastAccess(item, lastPlayedUtc),
                    isEngaged,
                    seriesId,
                    seasonNumber,
                    episodeNumber,
                    IsLibraryRoot: item.ParentId == libraryFolderId);
            }))
            .Where(candidate => byId.ContainsKey(candidate.ItemId))
            .Select(candidate => new LifecycleItem(
                byId[candidate.ItemId],
                candidate.SubtreeIds,
                candidate.EffectiveLastAccessUtc,
                candidate.IsEngaged,
                candidate.IsPromoted))
            .ToList();
    }

    internal static int CountDescendants(IReadOnlyCollection<BaseItem> items, Guid rootId)
    {
        var children = items
            .GroupBy(item => item.ParentId)
            .ToDictionary(group => group.Key, group => group.Select(item => item.Id).ToArray());
        var discovered = new HashSet<Guid>();
        var pending = new Stack<Guid>();
        pending.Push(rootId);
        while (pending.TryPop(out var parentId))
        {
            if (!children.TryGetValue(parentId, out var childIds))
                continue;
            foreach (var childId in childIds)
            {
                if (!discovered.Add(childId))
                    continue;
                pending.Push(childId);
            }
        }

        return discovered.Count;
    }

    /// <summary>
    /// Aggregates per-user playback state for one item. Never throws: engagement is a
    /// protection signal, and an unavailable user-data store must degrade to "not engaged"
    /// rather than break materialization or cleanup.
    /// </summary>
    private (bool IsEngaged, DateTime? LastPlayedUtc) ResolveEngagement(BaseItem item)
    {
        var engaged = false;
        DateTime? lastPlayed = null;
        try
        {
            foreach (var user in userManager.GetUsers())
            {
                if (userDataManager.GetUserData(user, item) is not { } data)
                    continue;

                engaged |= data.PlaybackPositionTicks > 0 || data.IsFavorite || data.Played;
                if (data.LastPlayedDate is { } played && (lastPlayed is null || played > lastPlayed))
                    lastPlayed = played;
            }
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not resolve user engagement for ephemeral item {ItemId}", item.Id);
        }

        return (engaged, lastPlayed);
    }

    /// <summary>
    /// Ensures the plugin folder exists, matches the configured placement (visible "Streamarr"
    /// library below the user root, or isolated below the aggregate root), and upgrades items
    /// written by earlier plugin versions. Legacy states are repaired in place, preserving
    /// user data: (a) rows persisted under plugin CLR subclasses, which Jellyfin's type-filtered
    /// native queries (Next Up, favorites sections, includeItemTypes) can never match, are
    /// re-saved as the built-in Movie/Series/Season/Episode types; (b) flat movies and series
    /// shells that used <c>IsVirtualItem=true</c> (filtered out of resume) or lacked a
    /// <c>PresentationUniqueKey</c> (collapsed away by de-duplicating queries) get both fixed.
    /// Runs at server start and whenever the configuration changes.
    /// </summary>
    public async Task EnsureLibraryIntegrationAsync(CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
            var upgraded = new List<BaseItem>();
            foreach (var item in GetEphemeralItems())
            {
                var target = CreateNativeReplacement(item);
                var changed = target is not null;
                target ??= item;
                if (target.IsVirtualItem && target is Movie or Series)
                {
                    target.IsVirtualItem = false;
                    changed = true;
                }

                if (string.IsNullOrWhiteSpace(target.PresentationUniqueKey))
                {
                    target.PresentationUniqueKey = target.CreatePresentationUniqueKey();
                    changed = true;
                }

                if (EnsureSeriesThumbFromBackdrop(target))
                    changed = true;

                if (changed)
                    upgraded.Add(target);
            }

            if (upgraded.Count > 0)
            {
                foreach (var parentGroup in upgraded.GroupBy(item => item.ParentId))
                {
                    if (libraryManager.GetItemById(parentGroup.Key) is not { } parent)
                    {
                        throw new InvalidOperationException(
                            $"The Streamarr hierarchy container {parentGroup.Key} is missing.");
                    }

                    await UpdateBatchAsync(parentGroup.ToArray(), parent, ct).ConfigureAwait(false);
                }
                logger.LogInformation(
                    "Upgraded {Count} ephemeral item(s) from a legacy compatibility state",
                    upgraded.Count);
            }
        }
        finally
        {
            _materializeGate.Release();
        }

        // Placement follows engagement from here on. On the first run after upgrading this also
        // clears a search-spammed library: everything never played/favorited moves to staging.
        await ReconcileEngagementPlacementAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Builds the built-in-typed replacement for a row persisted under a legacy plugin CLR
    /// subclass, copying every persisted field. Saving it under the same id rewrites the row's
    /// type in place — user data (resume positions, favorites, watched state) is untouched.
    /// Returns null when the item already uses a built-in type.
    /// </summary>
    private static BaseItem? CreateNativeReplacement(BaseItem legacy)
    {
        BaseItem? target = legacy switch
        {
            Movie movie when movie.GetType() != typeof(Movie) => new Movie(),
            Episode episode when episode.GetType() != typeof(Episode) => new Episode(),
            Season season when season.GetType() != typeof(Season) => new Season(),
            Series series when series.GetType() != typeof(Series) => new Series(),
            _ => null,
        };
        if (target is null)
            return null;

        target.Id = legacy.Id;
        target.Name = legacy.Name;
        target.Overview = legacy.Overview;
        target.ParentId = legacy.ParentId;
        target.ProviderIds = new Dictionary<string, string>(legacy.ProviderIds, StringComparer.OrdinalIgnoreCase);
        target.Tags = legacy.Tags;
        target.PremiereDate = legacy.PremiereDate;
        target.ProductionYear = legacy.ProductionYear;
        target.RunTimeTicks = legacy.RunTimeTicks;
        target.IndexNumber = legacy.IndexNumber;
        target.ParentIndexNumber = legacy.ParentIndexNumber;
        target.IsVirtualItem = legacy.IsVirtualItem;
        target.PresentationUniqueKey = legacy.PresentationUniqueKey;
        target.DateCreated = legacy.DateCreated;
        target.DateModified = legacy.DateModified;
        target.ImageInfos = legacy.ImageInfos;
        if (legacy is Episode legacyEpisode && target is Episode targetEpisode)
        {
            targetEpisode.SeriesId = legacyEpisode.SeriesId;
            targetEpisode.SeasonId = legacyEpisode.SeasonId;
            targetEpisode.SeriesName = legacyEpisode.SeriesName;
            targetEpisode.SeasonName = legacyEpisode.SeasonName;
            targetEpisode.SeriesPresentationUniqueKey = legacyEpisode.SeriesPresentationUniqueKey;
        }

        if (legacy is Season legacySeason && target is Season targetSeason)
        {
            targetSeason.SeriesId = legacySeason.SeriesId;
            targetSeason.SeriesName = legacySeason.SeriesName;
            targetSeason.SeriesPresentationUniqueKey = legacySeason.SeriesPresentationUniqueKey;
        }

        return target;
    }

    private static bool EnsureSeriesThumbFromBackdrop(BaseItem item)
    {
        if (item is not Series series
            || series.HasImage(ImageType.Thumb, 0)
            || series.GetImageInfo(ImageType.Backdrop, 0) is not { } backdrop)
        {
            return false;
        }

        series.SetImage(new ItemImageInfo
        {
            Path = backdrop.Path,
            Type = ImageType.Thumb,
            DateModified = backdrop.DateModified,
            Width = backdrop.Width,
            Height = backdrop.Height,
            BlurHash = backdrop.BlurHash,
        }, 0);
        return true;
    }

    public async Task<int> PruneOrphanedReleaseStateAsync(CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ownedItemIds = GetEphemeralItems().Select(item => item.Id).ToHashSet();
            var orphanedIds = store.All()
                .Where(entry => !ownedItemIds.Contains(entry.ItemId))
                .Select(entry => entry.ItemId)
                .ToArray();
            return store.RemoveRange(orphanedIds);
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    /// <summary>True only after a full batch committed and every expected direct child remains.</summary>
    public bool IsHierarchyComplete(Guid parentId, BaseItemKind childKind)
    {
        if (libraryManager.GetItemById(parentId) is not { } parent)
            return false;

        var children = GetEphemeralItems().Where(item =>
                item.ParentId == parentId
                && IsOwnedItem(item, parentId)
                && childKind switch
                {
                    BaseItemKind.Season => item is Season,
                    BaseItemKind.Episode => item is Episode,
                    _ => false,
                })
            .ToArray();
        if (children.Any(child => !HasNavigableHierarchyMetadata(parent, child, childKind)))
            return false;

        var childIds = children.Select(item => item.Id).ToArray();
        var workIds = children.ToDictionary(
            item => item.Id,
            item => item.ProviderIds.GetValueOrDefault(WorkIdProviderKey));
        return HasCompleteChildSet(
            parent,
            childIds,
            childKind == BaseItemKind.Episode
                ? itemId => store.Peek(itemId) is { } entry
                            && string.Equals(entry.Work.WorkId, workIds[itemId], StringComparison.Ordinal)
                : null);
    }

    /// <summary>
    /// Detects hierarchy rows written by pre-fix plugin versions. Jellyfin's native TV queries
    /// join children by SeriesPresentationUniqueKey and exclude virtual/missing rows for normal
    /// users, so a child-count marker alone is not sufficient evidence of a usable hierarchy.
    /// </summary>
    internal static bool HasNavigableHierarchyMetadata(
        BaseItem parent,
        BaseItem child,
        BaseItemKind childKind)
    {
        return childKind switch
        {
            BaseItemKind.Season
                when parent is Series series && child is Season season
                => !season.IsVirtualItem
                   && season.SeriesId == series.Id
                   && !string.IsNullOrWhiteSpace(series.PresentationUniqueKey)
                   && !string.IsNullOrWhiteSpace(season.PresentationUniqueKey)
                   && string.Equals(
                       season.SeriesPresentationUniqueKey,
                       series.GetPresentationUniqueKey(),
                       StringComparison.Ordinal),
            BaseItemKind.Episode
                when parent is Season season && child is Episode episode
                => !episode.IsVirtualItem
                   && episode.ParentId == season.Id
                   && episode.SeasonId == season.Id
                   && episode.SeriesId == season.SeriesId
                   && !string.IsNullOrWhiteSpace(season.PresentationUniqueKey)
                   && !string.IsNullOrWhiteSpace(season.SeriesPresentationUniqueKey)
                   && string.Equals(
                       episode.SeriesPresentationUniqueKey,
                       season.SeriesPresentationUniqueKey,
                       StringComparison.Ordinal),
            _ => false,
        };
    }

    /// <summary>
    /// Revalidates and commits a claimed cleanup deletion while hierarchy materialization is
    /// excluded. The caller must hold deletion claims for every expected subtree item.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> TryDeleteLifecycleTreeAsync(
        Guid itemId,
        IReadOnlySet<Guid> expectedSubtreeIds,
        DateTime expirationCutoffUtc,
        CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var lifecycle = GetLifecycleItems();
            var current = lifecycle.FirstOrDefault(candidate => candidate.Item.Id == itemId);
            if (current is null
                || !CanDeleteLifecycleCandidate(
                    expectedSubtreeIds,
                    current.SubtreeIds,
                    current.EffectiveLastAccessUtc,
                    expirationCutoffUtc,
                    lifecycle.Count(item => !item.IsPromoted) > MaxEphemeralItems,
                    current.IsEngaged,
                    current.IsPromoted))
            {
                return [];
            }

            ct.ThrowIfCancellationRequested();
            await InvalidateHierarchyCompletionAsync(current.Item.ParentId, ct).ConfigureAwait(false);
            lifecycle = GetLifecycleItems();
            current = lifecycle.FirstOrDefault(candidate => candidate.Item.Id == itemId);
            if (current is null
                || !CanDeleteLifecycleCandidate(
                    expectedSubtreeIds,
                    current.SubtreeIds,
                    current.EffectiveLastAccessUtc,
                    expirationCutoffUtc,
                    lifecycle.Count(item => !item.IsPromoted) > MaxEphemeralItems,
                    current.IsEngaged,
                    current.IsPromoted))
            {
                return [];
            }

            ct.ThrowIfCancellationRequested();
            lock (_hierarchyProtectionSync)
            {
                // Coordinate the last synchronous delete with recursive-series reservation.
                // If deletion wins, reservation begins only after the missing subtree is visible;
                // if reservation wins, cleanup leaves the complete series untouched.
                lifecycle = GetLifecycleItems();
                current = lifecycle.FirstOrDefault(candidate => candidate.Item.Id == itemId);
                var reservedProtection = SelectProtectedHierarchyIds(
                    lifecycle,
                    new HashSet<Guid>(),
                    protectDescendantsOfProtectedItems: false,
                    _seriesHierarchyReservations.Keys.ToHashSet());
                if (current is null
                    || reservedProtection.Contains(current.Item.Id)
                    || !CanDeleteLifecycleCandidate(
                        expectedSubtreeIds,
                        current.SubtreeIds,
                        current.EffectiveLastAccessUtc,
                        expirationCutoffUtc,
                        lifecycle.Count(item => !item.IsPromoted) > MaxEphemeralItems,
                        current.IsEngaged,
                        current.IsPromoted))
                {
                    return [];
                }

                return DeleteTreeCore(current.Item, removeReleaseState: true);
            }
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    /// <summary>
    /// Moves the subtree containing <paramref name="itemId"/> into the visible "Streamarr"
    /// library after a user deliberately engaged with it (playback start, favorite, or watched
    /// state). TopParentId and the ancestor rows are only recomputed for items that are re-saved,
    /// so the whole subtree is re-saved — Jellyfin's view-scoped queries (Continue Watching,
    /// Next Up, Latest) filter on exactly those persisted columns. Returns true when a move
    /// happened, false when the item is unknown, not plugin-owned, or already promoted.
    /// </summary>
    public async Task<bool> TryPromoteToLibraryAsync(Guid itemId, CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
            if (ResolveOwnedSubtreeRoot(itemId, roots) is not { } root
                || root.ParentId == roots.Library.Id)
            {
                return false;
            }

            await ReparentSubtreeAsync(root, roots.Library, ct).ConfigureAwait(false);
            logger.LogInformation(
                "Promoted engaged ephemeral subtree {ItemId} ({Name}) into the Streamarr library",
                root.Id,
                root.Name);
            return true;
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    /// <summary>
    /// Moves a no-longer-engaged subtree back into the hidden staging root. This is the explicit
    /// "remove from my library" gesture — unfavorite plus mark-unwatched works from every client —
    /// after which the item keeps working through search/playback and simply ages out by TTL again.
    /// Active playback sessions block the move; engagement re-promotes moments later anyway.
    /// </summary>
    public async Task<bool> TryDemoteFromLibraryAsync(Guid itemId, CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
            if (ResolveOwnedSubtreeRoot(itemId, roots) is not { } root
                || root.ParentId != roots.Library.Id)
            {
                return false;
            }

            var candidate = GetLifecycleItems().FirstOrDefault(item => item.Item.Id == root.Id);
            if (candidate is null
                || candidate.IsEngaged
                || candidate.SubtreeIds.Any(id => tracker.ForItem(id).Count > 0))
            {
                return false;
            }

            await ReparentSubtreeAsync(root, roots.Staging, ct).ConfigureAwait(false);
            logger.LogInformation(
                "Demoted unengaged ephemeral subtree {ItemId} ({Name}) back to staging",
                root.Id,
                root.Name);
            return true;
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    /// <summary>
    /// Aligns subtree placement with actual engagement: engaged staging subtrees are promoted
    /// into the visible library, no-longer-engaged library subtrees are demoted back to staging.
    /// Runs at startup and on config save (which doubles as the one-time upgrade migration that
    /// cleans a pre-engagement-gated, search-spammed library) and from scheduled cleanup as a
    /// backstop for events missed while the server was down.
    /// </summary>
    public async Task<(int Promoted, int Demoted)> ReconcileEngagementPlacementAsync(CancellationToken ct)
    {
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var roots = await EnsureFoldersAsync(ct).ConfigureAwait(false);
            var promoted = 0;
            var demoted = 0;
            foreach (var candidate in GetLifecycleItems())
            {
                ct.ThrowIfCancellationRequested();
                if (candidate.Item.ParentId == roots.Staging.Id && candidate.IsEngaged)
                {
                    await ReparentSubtreeAsync(candidate.Item, roots.Library, ct).ConfigureAwait(false);
                    promoted++;
                }
                else if (candidate.Item.ParentId == roots.Library.Id
                         && !candidate.IsEngaged
                         && !candidate.SubtreeIds.Any(id => tracker.ForItem(id).Count > 0))
                {
                    await ReparentSubtreeAsync(candidate.Item, roots.Staging, ct).ConfigureAwait(false);
                    demoted++;
                }
            }

            if (promoted > 0 || demoted > 0)
            {
                logger.LogInformation(
                    "Engagement placement reconciled: {Promoted} subtree(s) promoted, {Demoted} demoted",
                    promoted,
                    demoted);
            }

            return (promoted, demoted);
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    /// <summary>Walks the parent chain up to the direct child of either plugin root, requiring
    /// plugin ownership at every hop so foreign items can never be reparented.</summary>
    private BaseItem? ResolveOwnedSubtreeRoot(Guid itemId, EphemeralRoots roots)
    {
        var current = libraryManager.GetItemById(itemId);
        for (var depth = 0; current is not null && depth < 8; depth++)
        {
            if (!IsOwnedFolder(current)
                || !current.ProviderIds.TryGetValue(WorkIdProviderKey, out var workId)
                || string.IsNullOrWhiteSpace(workId))
            {
                return null;
            }

            if (current.ParentId == roots.Library.Id || current.ParentId == roots.Staging.Id)
                return current;
            current = libraryManager.GetItemById(current.ParentId);
        }

        return null;
    }

    /// <summary>
    /// Reparents a root-level subtree below <paramref name="destination"/>. The root is saved
    /// first so its new parent is persisted before descendants recompute their ancestor chains,
    /// then every descendant level is re-saved breadth-first (parents before children).
    /// </summary>
    private async Task ReparentSubtreeAsync(
        BaseItem root,
        StreamarrEphemeralFolder destination,
        CancellationToken ct)
    {
        var sourceParentId = root.ParentId;
        root.ParentId = destination.Id;
        await libraryManager
            .UpdateItemAsync(root, destination, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);

        var childrenByParent = GetEphemeralItems()
            .GroupBy(item => item.ParentId)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var pending = new Queue<BaseItem>();
        pending.Enqueue(root);
        while (pending.TryDequeue(out var parent))
        {
            ct.ThrowIfCancellationRequested();
            if (!childrenByParent.TryGetValue(parent.Id, out var children))
                continue;

            await UpdateBatchAsync(children, parent, ct).ConfigureAwait(false);
            foreach (var child in children)
                pending.Enqueue(child);
        }

        // Folder instances lazily cache their loaded child list (Folder._children). The database
        // is already correct here, but parent-scoped queries (the library's list view) would keep
        // serving the cached list — drop it on both roots so the move is visible immediately.
        foreach (var folderId in (Guid[])[sourceParentId, destination.Id])
        {
            if (libraryManager.GetItemById(folderId) is Folder folder)
                folder.Children = null!;
        }
    }

    internal static bool CanDeleteLifecycleCandidate(
        IReadOnlySet<Guid> expectedSubtreeIds,
        IReadOnlySet<Guid> currentSubtreeIds,
        DateTime? effectiveLastAccessUtc,
        DateTime expirationCutoffUtc,
        bool capacityOverflow,
        bool isEngaged,
        bool isPromoted)
        => !isPromoted
           && expectedSubtreeIds.SetEquals(currentSubtreeIds)
           && (capacityOverflow
               || (!isEngaged
                   && (effectiveLastAccessUtc is null
                       || effectiveLastAccessUtc < expirationCutoffUtc)));

    internal static bool HasExpectedChildCount(BaseItem parent, int actualChildCount)
        => actualChildCount >= 0
           && parent.ProviderIds.TryGetValue(ExpectedChildCountProviderKey, out var value)
           && int.TryParse(
               value,
               System.Globalization.NumberStyles.None,
               System.Globalization.CultureInfo.InvariantCulture,
               out var expected)
           && expected >= 0
           && actualChildCount == expected;

    internal static bool HasCompleteChildSet(
        BaseItem parent,
        IReadOnlyCollection<Guid> childIds,
        Func<Guid, bool>? hasRequiredState)
        => HasExpectedChildCount(parent, childIds.Count)
           && (hasRequiredState is null || childIds.All(hasRequiredState));

    internal static IReadOnlyList<BaseItem> SelectStaleDirectChildren(
        IEnumerable<BaseItem> items,
        Guid parentId,
        BaseItemKind childKind,
        IReadOnlySet<Guid> authoritativeIds)
    {
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(authoritativeIds);
        return items
            .Where(item => item.ParentId == parentId
                           && IsOwnedItem(item, parentId)
                           && !authoritativeIds.Contains(item.Id)
                           && childKind switch
                           {
                               BaseItemKind.Season => item is Season,
                               BaseItemKind.Episode => item is Episode,
                               _ => false,
                           })
            .ToList();
    }

    private DateTime? ResolveOwnLastAccess(BaseItem item, DateTime? lastPlayedUtc)
    {
        var access = store.Peek(item.Id)?.LastAccessedUtc
                     ?? (item.DateLastSaved != DateTime.MinValue
                         ? item.DateLastSaved
                         : item.DateCreated != DateTime.MinValue ? item.DateCreated : null);
        // A finished watch clears the resume position, so the play timestamp itself must count
        // as access — otherwise an item could expire minutes after the credits roll.
        if (lastPlayedUtc is { } played && (access is null || played > access))
            return played;
        return access;
    }

    /// <summary>
    /// All items owned by this plugin below its deterministic private folder. A tag alone is never
    /// treated as proof of ownership: users are free to use the same tag on ordinary library items.
    /// </summary>
    public IReadOnlyList<BaseItem> GetEphemeralItems()
    {
        // Jellyfin's recursive repository query recognizes folders by its built-in CLR type-name
        // map. Plugin Series/Season subclasses are persisted under their concrete names, so native
        // recursion stops before nested episodes. Walk direct ParentId edges instead, requiring
        // explicit ownership at every hop and de-duplicating ids to remain safe under corrupt data.
        // Both plugin roots are walked: the visible library (engaged history) and hidden staging.
        var result = new List<BaseItem>();
        var discovered = new HashSet<Guid>();
        var expandedParents = new HashSet<Guid>();
        var pendingParents = new Stack<Guid>();
        foreach (var folderId in (Guid[])[FolderId, StagingFolderId])
        {
            if (libraryManager.GetItemById(folderId) is StreamarrEphemeralFolder folder
                && IsOwnedFolder(folder))
            {
                pendingParents.Push(folder.Id);
            }
        }
        while (pendingParents.TryPop(out var parentId))
        {
            if (!expandedParents.Add(parentId))
                continue;

            var directChildren = libraryManager.GetItemList(new InternalItemsQuery
            {
                ParentId = parentId,
                Recursive = false,
            });
            foreach (var item in directChildren)
            {
                if (!IsOwnedItem(item, parentId) || !discovered.Add(item.Id))
                    continue;

                result.Add(item);
                if (item.IsFolder)
                    pendingParents.Push(item.Id);
            }
        }

        return result;
    }

    /// <summary>Deletes a materialized ephemeral item (no file on disk — these are virtual).</summary>
    public void Delete(BaseItem item)
        => libraryManager.DeleteItem(item, new DeleteOptions { DeleteFileLocation = false });

    private IReadOnlyList<Guid> DeleteTreeCore(
        BaseItem item,
        bool removeReleaseState,
        IReadOnlySet<Guid>? knownSubtreeIds = null)
    {
        var subtreeIds = knownSubtreeIds
                         ?? GetLifecycleItems()
                             .FirstOrDefault(candidate => candidate.Item.Id == item.Id)
                             ?.SubtreeIds
                         ?? new HashSet<Guid> { item.Id };
        foreach (var itemId in subtreeIds)
            _ = tracker.TakeForItem(itemId);

        Delete(item);
        if (removeReleaseState)
            store.RemoveRange(subtreeIds);
        return subtreeIds.ToArray();
    }

    private bool LibraryIntegrationEnabled
        => Plugin.Instance?.Configuration.LibraryEnabled ?? true;

    /// <summary>
    /// The container the folder must live under: the user root (folder becomes a visible
    /// "Streamarr" library and its children join every view-scoped query) when integration is
    /// enabled, the hidden aggregate root (fully isolated legacy behavior) when disabled.
    /// </summary>
    private Folder DesiredFolderParent
        => LibraryIntegrationEnabled
            ? libraryManager.GetUserRootFolder()
            : libraryManager.RootFolder;

    internal sealed record EphemeralRoots(StreamarrEphemeralFolder Library, StreamarrEphemeralFolder Staging);

    /// <summary>
    /// Ensures both plugin roots exist and match their placement: the visible "Streamarr" library
    /// folder (user root, or aggregate root when integration is disabled) holding the engaged
    /// history, and the always-hidden staging folder (aggregate root) holding raw search hits.
    /// </summary>
    private async Task<EphemeralRoots> EnsureFoldersAsync(CancellationToken ct)
    {
        var library = await EnsureFolderCoreAsync(
                FolderId, FolderName, DesiredFolderParent, "ephemeral-library", ct)
            .ConfigureAwait(false);
        var staging = await EnsureFolderCoreAsync(
                StagingFolderId, StagingFolderName, libraryManager.RootFolder, "ephemeral-staging", ct)
            .ConfigureAwait(false);
        await MigrateLegacyFolderAsync(library, ct).ConfigureAwait(false);
        return new EphemeralRoots(library, staging);
    }

    private async Task<StreamarrEphemeralFolder> EnsureFolderCoreAsync(
        Guid folderId,
        string name,
        Folder parent,
        string pathSegment,
        CancellationToken ct)
    {
        var existingItem = libraryManager.GetItemById(folderId);
        StreamarrEphemeralFolder folder;
        if (existingItem is StreamarrEphemeralFolder existing && IsOwnedFolder(existing))
        {
            folder = existing;
            var changed = false;
            if (string.IsNullOrWhiteSpace(folder.Path))
            {
                folder.Path = EnsureFolderPath(pathSegment);
                changed = true;
            }

            if (string.IsNullOrWhiteSpace(folder.PresentationUniqueKey))
            {
                folder.PresentationUniqueKey = folder.CreatePresentationUniqueKey();
                changed = true;
            }

            // Upgrades from the isolated era rename the folder and move it below the user root.
            if (!string.Equals(folder.Name, name, StringComparison.Ordinal))
            {
                folder.Name = name;
                changed = true;
            }

            var reparented = folder.ParentId != parent.Id;
            if (reparented)
            {
                folder.ParentId = parent.Id;
                changed = true;
            }

            if (changed)
            {
                await libraryManager
                    .UpdateItemAsync(folder, parent, ItemUpdateType.MetadataEdit, ct)
                    .ConfigureAwait(false);
            }

            if (reparented)
                InvalidateUserRootChildren();
        }
        else
        {
            if (existingItem is not null)
                throw new InvalidOperationException($"Refusing to reuse non-Streamarr folder {folderId}.");

            // Direct item authorization is enforced by Movie/Episode.
            folder = new StreamarrEphemeralFolder
            {
                Id = folderId,
                Name = name,
                ParentId = parent.Id,
                Path = EnsureFolderPath(pathSegment),
                IsVirtualItem = true,
            };
            folder.PresentationUniqueKey = folder.CreatePresentationUniqueKey();
            ApplyOwnership(folder);
            ApplyTags(folder);
            ct.ThrowIfCancellationRequested();
            libraryManager.CreateItems([folder], parent, ct);
            ct.ThrowIfCancellationRequested();
            await libraryManager
                .UpdateItemAsync(folder, parent, ItemUpdateType.MetadataEdit, ct)
                .ConfigureAwait(false);
            InvalidateUserRootChildren();
            logger.LogInformation(
                "Created ephemeral folder {Name} ({FolderId}) below parent {ParentId}",
                name,
                folderId,
                parent.Id);
        }

        return folder;
    }

    /// <summary>
    /// The user root folder caches its child-id list. Queue a lightweight metadata refresh so
    /// <c>BeforeMetadataRefresh</c> clears that cache and the "Streamarr" library (dis)appears
    /// without a server restart. Failure is non-fatal: the next library validation clears it too.
    /// </summary>
    private void InvalidateUserRootChildren()
    {
        try
        {
            providerManager.QueueRefresh(
                libraryManager.GetUserRootFolder().Id,
                new MetadataRefreshOptions(new DirectoryService(fileSystem)),
                RefreshPriority.High);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not queue a user-root refresh after moving the Streamarr folder");
        }
    }

    private string EnsureFolderPath(string pathSegment)
    {
        var path = Path.Combine(applicationPaths.DataPath, "streamarr", pathSegment);
        Directory.CreateDirectory(path);
        return path;
    }

    private async Task MigrateLegacyFolderAsync(StreamarrEphemeralFolder destination, CancellationToken ct)
    {
        if (libraryManager.GetItemById(LegacyFolderId) is not Folder legacy
            || legacy.Id == destination.Id
            || !string.Equals(legacy.Name, LegacyFolderName, StringComparison.Ordinal)
            || !legacy.Tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        var legacyChildren = legacy.GetRecursiveChildren().ToArray();
        var ownedChildren = legacyChildren.Where(IsLegacyOwnedItem).ToArray();
        foreach (var item in ownedChildren)
        {
            ct.ThrowIfCancellationRequested();
            item.ParentId = destination.Id;
            item.IsVirtualItem = true;
            ApplyOwnership(item);
        }
        await UpdateBatchAsync(ownedChildren, destination, ct).ConfigureAwait(false);

        // Ownership is established by the deterministic legacy folder id plus our provider id,
        // never by a tag alone. After all children move, the obsolete visible folder is safe to remove.
        if (legacyChildren.Length == 0)
            libraryManager.DeleteItem(legacy, new DeleteOptions { DeleteFileLocation = false });
        else if (ownedChildren.Length != legacyChildren.Length)
            logger.LogWarning("Legacy Streamarr folder contains non-plugin items and was intentionally retained");
        else
            logger.LogInformation("Legacy Streamarr folder was emptied and will be removed after Jellyfin reloads it");
        logger.LogInformation("Migrated {Count} legacy Streamarr ephemeral item(s) into the private folder", ownedChildren.Length);
    }

    private bool IsLegacyOwnedItem(BaseItem item)
        => item.ParentId == LegacyFolderId
           && item.ProviderIds.TryGetValue(WorkIdProviderKey, out var workId)
           && !string.IsNullOrWhiteSpace(workId)
           && item.Tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase);

    private static bool IsEpisode(WorkDto work)
        => string.Equals(work.MediaType, "tv", StringComparison.OrdinalIgnoreCase)
           || string.Equals(work.MediaType, "episode", StringComparison.OrdinalIgnoreCase);

    private void ValidateHierarchyOwnership(
        BaseItem? existing,
        Guid expectedParentId,
        string workId,
        Guid itemId)
    {
        if (existing is not null
            && !CanAdoptHierarchyItem(existing, expectedParentId, FolderId, StagingFolderId, workId))
        {
            throw new InvalidOperationException($"Refusing to modify non-Streamarr item {itemId}.");
        }
    }

    private static bool IsOwnedRootChild(BaseItem item, EphemeralRoots roots)
        => IsOwnedItem(item, roots.Staging.Id) || IsOwnedItem(item, roots.Library.Id);

    /// <summary>
    /// Accepts the requested hierarchy parent or either deterministic private root (visible
    /// library or hidden staging). The root fallback is the one-time upgrade path for flat TV
    /// rows created by plugin 0.3 and earlier.
    /// </summary>
    internal static bool CanAdoptHierarchyItem(
        BaseItem item,
        Guid expectedParentId,
        Guid folderId,
        Guid stagingFolderId,
        string workId)
        => HasWorkId(item, workId)
           && (IsOwnedItem(item, expectedParentId)
               || IsOwnedItem(item, folderId)
               || IsOwnedItem(item, stagingFolderId));

    private void DeleteForRetype(BaseItem item, bool removeReleaseState)
    {
        var claimedIds = new HashSet<Guid> { item.Id };
        if (!tracker.TryClaimItemsForDeletion(claimedIds, requireNoSessions: true, out _))
        {
            throw new InvalidOperationException($"Could not retire active Streamarr item {item.Id} for hierarchy migration.");
        }

        try
        {
            Delete(item);
            if (removeReleaseState)
                store.Remove(item.Id);
        }
        finally
        {
            tracker.ReleaseDeletionClaim(claimedIds);
        }
    }

    private static void ApplyProviderIds(BaseItem item, WorkDto work)
        => ApplyProviderIds(item, work.WorkId, work.TmdbId, work.ImdbId);

    private static void ApplyProviderIds(BaseItem item, string workId, int? tmdbId, string? imdbId)
    {
        item.ProviderIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (tmdbId is { } tmdb)
            item.ProviderIds[MetadataProvider.Tmdb.ToString()] = tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (!string.IsNullOrWhiteSpace(imdbId))
            item.ProviderIds[MetadataProvider.Imdb.ToString()] = imdbId;
        item.ProviderIds[WorkIdProviderKey] = workId;
        item.ProviderIds[OwnerProviderKey] = OwnerProviderValue;
    }

    private static bool TryTmdbId(BaseItem item, out int tmdbId)
    {
        tmdbId = 0;
        return item.ProviderIds.TryGetValue(MetadataProvider.Tmdb.ToString(), out var value)
               && int.TryParse(
                   value,
                   System.Globalization.NumberStyles.None,
                   System.Globalization.CultureInfo.InvariantCulture,
                   out tmdbId)
               && tmdbId > 0;
    }

    private static void ApplyAirDate(BaseItem item, string? airDate)
    {
        if (!DateOnly.TryParseExact(
                airDate,
                "yyyy-MM-dd",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.None,
                out var parsed))
        {
            return;
        }

        item.PremiereDate = DateTime.SpecifyKind(parsed.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc);
        item.ProductionYear = parsed.Year;
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

    private static bool HasWorkId(BaseItem item, string workId)
        => item.ProviderIds.TryGetValue(WorkIdProviderKey, out var existingWorkId)
           && string.Equals(existingWorkId, workId, StringComparison.Ordinal);

    private static void ApplyTags(BaseItem item)
    {
        var tags = item.Tags?.ToList() ?? [];
        if (!tags.Contains(EphemeralTag, StringComparer.OrdinalIgnoreCase))
            tags.Add(EphemeralTag);
        if (!tags.Contains(StreamarrTag, StringComparer.OrdinalIgnoreCase))
            tags.Add(StreamarrTag);
        item.Tags = tags.ToArray();
    }

    private static void ApplyMetadata(
        BaseItem item,
        float? communityRating,
        string? originalTitle,
        string? tagline,
        string? officialRating,
        IReadOnlyList<string> genres,
        IReadOnlyList<string> studios,
        IReadOnlyList<string> productionLocations,
        string? trailerUrl)
    {
        item.CommunityRating = communityRating;
        item.OriginalTitle = originalTitle;
        item.Tagline = tagline;
        item.OfficialRating = officialRating;
        item.Genres = genres.ToArray();
        item.SetStudios(studios);
        item.ProductionLocations = productionLocations.ToArray();
        item.RemoteTrailers = string.IsNullOrWhiteSpace(trailerUrl)
            ? []
            : [new MediaUrl { Name = "Trailer", Url = trailerUrl }];
    }

    private Task EnrichWorkAsync(WorkDto work, CancellationToken ct)
        => EnrichOneAsync(
            work.WorkId,
            work.PosterUrl,
            work.AddStreamarrBadge,
            work.People,
            ct);

    private Task EnrichSeriesAsync(TvSeriesDto series, CancellationToken ct)
        => EnrichOneAsync(
            series.WorkId,
            series.PosterUrl,
            series.AddStreamarrBadge,
            series.People,
            ct);

    private async Task EnrichOneAsync(
        string workId,
        string? sourceUrl,
        bool badgeEnabled,
        IReadOnlyList<PersonDto> people,
        CancellationToken ct)
    {
        var image = await artworkBadge.GetPosterAsync(sourceUrl, workId, badgeEnabled, ct)
            .ConfigureAwait(false);
        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (TryGetOwnedWork(workId) is not { } item)
                return;
            await UpdateEnrichedItemAsync(item, image, people, ct).ConfigureAwait(false);
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    private async Task EnrichSeasonsAsync(TvSeriesDetailsResponse details, CancellationToken ct)
    {
        var seriesImageTask = artworkBadge.GetPosterAsync(
            details.Series.PosterUrl,
            details.Series.WorkId,
            details.Series.AddStreamarrBadge,
            ct);
        var seasonImageTasks = details.Seasons.ToDictionary(
            season => season.WorkId,
            season => artworkBadge.GetPosterAsync(
                season.PosterUrl,
                season.WorkId,
                details.Series.AddStreamarrBadge,
                ct));
        await Task.WhenAll(seasonImageTasks.Values.Append(seriesImageTask)).ConfigureAwait(false);

        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (TryGetOwnedWork(details.Series.WorkId) is { } series)
            {
                await UpdateEnrichedItemAsync(
                        series,
                        await seriesImageTask.ConfigureAwait(false),
                        details.Series.People,
                        ct)
                    .ConfigureAwait(false);
            }
            foreach (var season in details.Seasons)
            {
                if (TryGetOwnedWork(season.WorkId) is not { } item)
                    continue;
                await UpdateEnrichedItemAsync(
                        item,
                        await seasonImageTasks[season.WorkId].ConfigureAwait(false),
                        [],
                        ct)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    private async Task EnrichEpisodesAsync(TvSeasonDetailsResponse details, CancellationToken ct)
    {
        var seriesImageTask = artworkBadge.GetPosterAsync(
            details.Series.PosterUrl,
            details.Series.WorkId,
            details.Series.AddStreamarrBadge,
            ct);
        var seasonImageTask = artworkBadge.GetPosterAsync(
            details.Season.PosterUrl,
            details.Season.WorkId,
            details.Series.AddStreamarrBadge,
            ct);
        var episodeImageTasks = details.Episodes.ToDictionary(
            episode => episode.WorkId,
            episode => artworkBadge.GetPosterAsync(
                episode.StillUrl,
                episode.WorkId,
                episode.AddStreamarrBadge,
                ct));
        await Task.WhenAll(episodeImageTasks.Values.Append(seriesImageTask).Append(seasonImageTask))
            .ConfigureAwait(false);

        await _materializeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (TryGetOwnedWork(details.Series.WorkId) is { } series)
            {
                await UpdateEnrichedItemAsync(
                        series,
                        await seriesImageTask.ConfigureAwait(false),
                        details.Series.People,
                        ct)
                    .ConfigureAwait(false);
            }
            if (TryGetOwnedWork(details.Season.WorkId) is { } season)
            {
                await UpdateEnrichedItemAsync(
                        season,
                        await seasonImageTask.ConfigureAwait(false),
                        [],
                        ct)
                    .ConfigureAwait(false);
            }
            foreach (var episode in details.Episodes)
            {
                if (TryGetOwnedWork(episode.WorkId) is not { } item)
                    continue;
                await UpdateEnrichedItemAsync(
                        item,
                        await episodeImageTasks[episode.WorkId].ConfigureAwait(false),
                        episode.People,
                        ct)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            _materializeGate.Release();
        }
    }

    private BaseItem? TryGetOwnedWork(string workId)
    {
        var item = libraryManager.GetItemById(ItemIdFor(workId));
        return item is not null && HasWorkId(item, workId) ? item : null;
    }

    private async Task UpdateEnrichedItemAsync(
        BaseItem item,
        string? image,
        IReadOnlyList<PersonDto> people,
        CancellationToken ct)
    {
        if (libraryManager.GetItemById(item.ParentId) is not { } parent)
            return;
        TryApplyImage(item, image, ImageType.Primary);
        await libraryManager.UpdateItemAsync(item, parent, ItemUpdateType.MetadataEdit, ct)
            .ConfigureAwait(false);
        if (people.Count > 0)
            await ApplyPeopleAsync(item, people, ct).ConfigureAwait(false);
    }

    private async Task ApplyPeopleAsync(
        BaseItem item,
        IReadOnlyList<PersonDto> people,
        CancellationToken ct)
    {
        var mapped = people
            .Take(100)
            .Select(ToPersonInfo)
            .Where(person => person is not null)
            .Cast<PersonInfo>()
            .ToArray();
        await libraryManager.UpdatePeopleAsync(item, mapped, ct).ConfigureAwait(false);
    }

    private static PersonInfo? ToPersonInfo(PersonDto person)
    {
        var kind = person.Type switch
        {
            "Actor" => PersonKind.Actor,
            "Director" => PersonKind.Director,
            "Writer" => PersonKind.Writer,
            "Producer" => PersonKind.Producer,
            "Composer" => PersonKind.Composer,
            _ => (PersonKind?)null,
        };
        if (kind is null || string.IsNullOrWhiteSpace(person.Name))
            return null;

        var result = new PersonInfo
        {
            Name = person.Name,
            Type = kind.Value,
            Role = person.Role,
            SortOrder = person.SortOrder,
            ImageUrl = person.ProfileUrl,
        };
        if (person.TmdbId is > 0)
        {
            result.ProviderIds[MetadataProvider.Tmdb.ToString()] =
                person.TmdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        return result;
    }

    private void TryApplyImage(BaseItem item, string? imageUrl, ImageType imageType)
    {
        if (string.IsNullOrWhiteSpace(imageUrl))
            return;
        try
        {
            // Pass TMDB artwork through as remote images so we never rely on
            // Jellyfin's own metadata fetcher for our items (BRIEF §3.2).
            item.SetImage(new ItemImageInfo { Path = imageUrl, Type = imageType }, 0);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not attach {ImageType} artwork for {Name}", imageType, item.Name);
        }
    }

    private sealed class SeriesHierarchyReservation(
        EphemeralLibraryService owner,
        Guid seriesId) : IDisposable
    {
        private EphemeralLibraryService? _owner = owner;

        public void Dispose()
            => Interlocked.Exchange(ref _owner, null)?.ReleaseSeriesHierarchy(seriesId);
    }
}

/// <summary>Pure hierarchy lifecycle calculations shared by capacity and scheduled cleanup.</summary>
internal static class EphemeralLifecycle
{
    internal sealed record Node(
        Guid ItemId,
        Guid ParentId,
        DateTime? LastAccessedUtc,
        bool IsEngaged = false,
        Guid? SeriesId = null,
        int? SeasonNumber = null,
        int? EpisodeNumber = null,
        bool IsLibraryRoot = false);

    internal sealed record Candidate(
        Guid ItemId,
        IReadOnlySet<Guid> SubtreeIds,
        DateTime? EffectiveLastAccessUtc,
        bool IsEngaged,
        bool IsPromoted = false);

    internal static IReadOnlyList<Candidate> Build(IEnumerable<Node> source)
    {
        ArgumentNullException.ThrowIfNull(source);
        var nodes = source
            .GroupBy(node => node.ItemId)
            .Select(group => group.First())
            .ToDictionary(node => node.ItemId);
        var children = nodes.Values
            .GroupBy(node => node.ParentId)
            .ToDictionary(group => group.Key, group => group.Select(node => node.ItemId).ToArray());
        var nextUpProtectedIds = ResolveNextUpProtectedIds(nodes.Values);
        // Everything below a library-root node is the user's promoted history: exempt from TTL
        // expiry and capacity eviction, and excluded from the ephemeral item count.
        var promotedIds = new HashSet<Guid>();
        foreach (var root in nodes.Values.Where(node => node.IsLibraryRoot))
        {
            var pendingPromoted = new Stack<Guid>();
            pendingPromoted.Push(root.ItemId);
            while (pendingPromoted.TryPop(out var promotedId))
            {
                if (!promotedIds.Add(promotedId) || !children.TryGetValue(promotedId, out var promotedChildIds))
                    continue;
                foreach (var childId in promotedChildIds)
                    pendingPromoted.Push(childId);
            }
        }

        var result = new List<Candidate>(nodes.Count);
        foreach (var node in nodes.Values)
        {
            var subtree = new HashSet<Guid>();
            var pending = new Stack<Guid>();
            pending.Push(node.ItemId);
            while (pending.TryPop(out var itemId))
            {
                if (!subtree.Add(itemId) || !children.TryGetValue(itemId, out var childIds))
                    continue;
                foreach (var childId in childIds)
                    pending.Push(childId);
            }

            var access = subtree
                .Select(itemId => nodes[itemId].LastAccessedUtc)
                .Where(value => value.HasValue)
                .Select(value => value!.Value)
                .DefaultIfEmpty()
                .Max();
            // Engagement anywhere in the subtree protects every ancestor: deleting a season
            // would take an engaged episode (and its Continue Watching entry) down with it. An
            // episode nobody has touched yet is also treated as engaged when it is the Next Up
            // candidate (immediately follows an engaged episode in series order) — otherwise it
            // ages out on the same clock as an item nobody cares about, and Jellyfin's Next Up
            // row silently goes empty until the series page is reloaded and it re-materializes.
            var engaged = subtree.Any(itemId => nodes[itemId].IsEngaged || nextUpProtectedIds.Contains(itemId));
            result.Add(new Candidate(
                node.ItemId,
                subtree,
                access == default ? null : access,
                engaged,
                promotedIds.Contains(node.ItemId)));
        }

        return result;
    }

    /// <summary>
    /// Finds, for every series represented in <paramref name="nodes"/>, the episode immediately
    /// following the last engaged (resumed, favorited, or watched) episode in season/episode
    /// order. That episode is Jellyfin's Next Up candidate even though nobody has engaged with it
    /// individually yet — only its predecessor. Only the single immediate successor is protected,
    /// not the rest of the season, so idle future episodes still expire normally.
    /// </summary>
    private static IReadOnlySet<Guid> ResolveNextUpProtectedIds(IEnumerable<Node> nodes)
    {
        var protectedIds = new HashSet<Guid>();
        var bySeries = nodes
            .Where(node => node.SeriesId is { } seriesId && seriesId != Guid.Empty)
            .GroupBy(node => node.SeriesId!.Value);

        foreach (var series in bySeries)
        {
            var ordered = series
                .OrderBy(node => node.SeasonNumber ?? int.MaxValue)
                .ThenBy(node => node.EpisodeNumber ?? int.MaxValue)
                .ToList();

            for (var i = 0; i < ordered.Count - 1; i++)
            {
                if (ordered[i].IsEngaged && !ordered[i + 1].IsEngaged)
                    protectedIds.Add(ordered[i + 1].ItemId);
            }
        }

        return protectedIds;
    }

    /// <summary>
    /// Deletion preference: non-engaged before engaged, then oldest access first. Engaged
    /// subtrees can therefore only fall to capacity pressure after every disposable subtree
    /// is gone, and TTL expiry skips them entirely.
    /// </summary>
    internal static IOrderedEnumerable<EphemeralLibraryService.LifecycleItem> OrderForDeletion(
        IEnumerable<EphemeralLibraryService.LifecycleItem> candidates)
        => candidates
            .OrderBy(candidate => candidate.IsEngaged ? 1 : 0)
            .ThenBy(candidate => candidate.EffectiveLastAccessUtc ?? DateTime.MinValue)
            .ThenByDescending(candidate => candidate.SubtreeIds.Count)
            .ThenBy(candidate => candidate.Item.Id);
}
