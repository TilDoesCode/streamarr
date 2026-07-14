using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Private parent for synthetic Streamarr items. The folder is deliberately invisible to every
/// Jellyfin user, which prevents its children from entering normal library traversal. Individual
/// children are exposed only after the search filter performs user and request-policy checks.
/// </summary>
public sealed class StreamarrEphemeralFolder : Folder
{
    public override bool IsHidden => true;

    // The directory path exists only to satisfy Jellyfin's aggregate-root invariants. Synthetic
    // children are database-backed and must never be reconciled against filesystem contents.
    protected override bool SupportsOwnedItems => false;

    // Jellyfin persists plugin-defined BaseItem subclasses by their CLR type but exposes the
    // client kind returned here. Reporting the standard folder kind keeps DTO generation and
    // database queries ABI-compatible with Jellyfin 10.11.
    public override string GetClientTypeName() => nameof(BaseItemKind.Folder);
}
