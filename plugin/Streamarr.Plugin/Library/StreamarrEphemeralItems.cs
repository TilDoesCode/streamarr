using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Plugin-owned movie whose direct-by-id visibility follows the same compatible-library policy
/// as search injection. This check is on the item itself so Jellyfin's PlaybackInfo authorization
/// cannot be bypassed by guessing a deterministic item id.
/// </summary>
public sealed class StreamarrMovie : Movie
{
    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: false);

    public override string GetClientTypeName() => nameof(BaseItemKind.Movie);
}

/// <summary>TV counterpart to <see cref="StreamarrMovie"/>.</summary>
public sealed class StreamarrEpisode : Episode
{
    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true);

    public override string GetClientTypeName() => nameof(BaseItemKind.Episode);
}

/// <summary>Series-level TV work used as the root of a lazily expanded hierarchy.</summary>
public sealed class StreamarrSeries : Series
{
    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
        => base.IsVisible(user, skipAllowedTagsCheck)
           && StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true);

    public override string GetClientTypeName() => nameof(BaseItemKind.Series);
}

/// <summary>Season directory below a <see cref="StreamarrSeries"/>.</summary>
public sealed class StreamarrSeason : Season
{
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
    /// each collection folder's own visibility policy preserves EnabledFolders/BlockedMediaFolders
    /// without recursing through this private non-collection folder.
    /// </summary>
    internal static bool HasCompatibleLibrary(User user, bool episode)
    {
        var root = BaseItem.LibraryManager.GetUserRootFolder();
        foreach (var child in root.Children)
        {
            if (child is not ICollectionFolder collection || !child.IsVisible(user, true))
                continue;

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
