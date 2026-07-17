using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Parent for synthetic Streamarr items. Deriving from <see cref="BasePluginFolder"/> makes this
/// folder a first-class library surface: placed below the user root folder it is returned by
/// <c>UserViewManager.GetUserViews</c> as its own "Streamarr" library, and because a
/// <see cref="BasePluginFolder"/> is a top parent, every child's persisted <c>TopParentId</c> is
/// this folder's id — which then appears in the view-scoped <c>TopParentIds</c> filter Jellyfin
/// applies to Continue Watching (resume), Next Up, Favorites and recursive user queries.
/// When library integration is disabled the folder is parented below the hidden aggregate root
/// instead, which removes it (and all children) from every user-facing view again.
/// Scan safety: <see cref="BasePluginFolder.CanDelete"/> returns <c>false</c>, so the user-root
/// reconciliation pass never removes the folder, and the children survive because Jellyfin only
/// deletes file-protocol items (the children report <c>LocationType.Remote</c>).
/// </summary>
public sealed class StreamarrEphemeralFolder : BasePluginFolder
{
    // A null collection type presents as a mixed-content library, which is correct for a folder
    // that contains both movies and TV hierarchies. It also keeps the folder out of Jellyfin's
    // movie/tvshow grouped preset views.
    public override CollectionType? CollectionType => null;

    // The directory path exists only to satisfy Jellyfin's aggregate-root invariants. Synthetic
    // children are database-backed and must never be reconciled against filesystem contents.
    protected override bool SupportsOwnedItems => false;

    // Jellyfin persists plugin-defined BaseItem subclasses by their CLR type but exposes the
    // client kind returned here. Reporting the standard folder kind keeps DTO generation and
    // database queries ABI-compatible with Jellyfin 10.11.
    public override string GetClientTypeName() => nameof(BaseItemKind.Folder);

    /// <summary>
    /// Jellyfin's <c>Folder.IsVisible</c> deliberately exempts <see cref="BasePluginFolder"/>
    /// from the per-user media-folder policy (the playlists folder wants that). This library
    /// must NOT be blanket-exempt: a user with no media access at all would otherwise silently
    /// gain access to every Usenet item. Access mirrors the plugin's long-standing item policy
    /// and adds Jellyfin's native controls on top:
    /// <list type="bullet">
    /// <item>an explicit entry in the user's BlockedMediaFolders always denies;</item>
    /// <item>EnableAllFolders or an explicit EnabledFolders grant allows;</item>
    /// <item>otherwise the compatible-library rule applies — users who can see at least one
    /// ordinary movie/TV/mixed library keep seeing ephemeral content, exactly as search
    /// injection always behaved for them.</item>
    /// </list>
    /// Because this folder participates in the compatible-library scan itself, its own id is
    /// excluded there to avoid recursing into this method.
    /// </summary>
    public override bool IsVisible(User user, bool skipAllowedTagsCheck = false)
    {
        if (user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).Contains(Id))
            return false;

        var granted = user.HasPermission(PermissionKind.EnableAllFolders)
                      || user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders).Contains(Id)
                      || StreamarrItemVisibility.HasCompatibleLibrary(user, episode: false, excludeFolderId: Id)
                      || StreamarrItemVisibility.HasCompatibleLibrary(user, episode: true, excludeFolderId: Id);
        if (!granted)
            return false;

        return base.IsVisible(user, skipAllowedTagsCheck);
    }
}
