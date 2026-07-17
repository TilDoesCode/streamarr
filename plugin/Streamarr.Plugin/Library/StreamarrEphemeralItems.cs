using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using JellyfinLocationType = MediaBrowser.Model.Entities.LocationType;

namespace Streamarr.Plugin.Library;

// ── LEGACY TYPE SHIMS ─────────────────────────────────────────────────────────────────────────
// Ephemeral items are now materialized as Jellyfin's BUILT-IN Movie/Series/Season/Episode types:
// the EF item repository matches type-filtered queries (Next Up, favorites sections,
// includeItemTypes) against exact built-in CLR type names, so plugin subclasses can never appear
// in those flows. These subclasses remain defined ONLY so rows written by plugin ≤0.5 still
// hydrate (unknown types make the repository throw); EnsureLibraryIntegrationAsync re-saves such
// rows under the built-in types at startup. Do not materialize these types for new items.
// Authorization did not regress: direct-by-id access runs IsVisibleStandalone, which applies the
// StreamarrEphemeralFolder media-folder policy to every ancestor chain.

/// <summary>
/// Legacy shim for rows written by plugin ≤0.5 — see the note above. Kept so existing database
/// rows hydrate; upgraded to a built-in <see cref="Movie"/> row at startup.
/// </summary>
public sealed class StreamarrMovie : Movie
{
    // Pathless plugin items are available through IMediaSourceProvider, not missing files.
    // Reporting Virtual makes Jellyfin Web suppress playback before it requests PlaybackInfo.
    public override JellyfinLocationType LocationType => JellyfinLocationType.Remote;

    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: false);

    public override string GetClientTypeName() => nameof(BaseItemKind.Movie);
}

/// <summary>Legacy shim — see <see cref="StreamarrMovie"/>.</summary>
public sealed class StreamarrEpisode : Episode
{
    public override JellyfinLocationType LocationType => JellyfinLocationType.Remote;

    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true);

    public override string GetClientTypeName() => nameof(BaseItemKind.Episode);
}

/// <summary>Legacy shim — see <see cref="StreamarrMovie"/>.</summary>
public sealed class StreamarrSeries : Series
{
    public override JellyfinLocationType LocationType => JellyfinLocationType.Remote;

    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true);

    public override string GetClientTypeName() => nameof(BaseItemKind.Series);
}

/// <summary>Legacy shim — see <see cref="StreamarrMovie"/>.</summary>
public sealed class StreamarrSeason : Season
{
    public override JellyfinLocationType LocationType => JellyfinLocationType.Remote;

    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true);

    public override string GetClientTypeName() => nameof(BaseItemKind.Season);
}

internal static class StreamarrItemVisibility
{
    /// <summary>
    /// A synthetic item is visible only when the user can see at least one ordinary Jellyfin
    /// library compatible with that media kind. Enumerating unfiltered root children and invoking
    /// each collection folder's own visibility policy preserves EnabledFolders/BlockedMediaFolders.
    /// <paramref name="excludeFolderId"/> lets the Streamarr folder itself run this rule without
    /// recursing into its own <c>IsVisible</c> (it is a user-root child too).
    /// </summary>
    internal static bool HasCompatibleLibrary(User user, bool episode, Guid excludeFolderId = default)
    {
        var root = BaseItem.LibraryManager.GetUserRootFolder();
        foreach (var child in root.Children)
        {
            if (child.Id == excludeFolderId
                || child is not ICollectionFolder collection
                || !child.IsVisible(user, true))
            {
                continue;
            }

            var compatible = collection.CollectionType switch
            {
                null or CollectionType.unknown or CollectionType.folders => true,
                CollectionType.tvshows => episode,
                CollectionType.movies or CollectionType.homevideos => !episode,
                _ => false,
            };
            if (compatible)
                return true;
        }

        return false;
    }
}
