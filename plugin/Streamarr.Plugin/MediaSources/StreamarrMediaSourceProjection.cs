using System.Globalization;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Builds the user-bound, unopened media sources exposed by both Jellyfin's playback API and
/// item DTOs. Keeping this in one place prevents detail pages from advertising Jellyfin's
/// pathless placeholder while PlaybackInfo advertises a different set of release ids.
/// </summary>
public sealed class StreamarrMediaSourceProjection(
    EphemeralReleaseStore store,
    MediaSourceOfferStore offers,
    ILogger<StreamarrMediaSourceProjection> logger)
{
    /// <summary>
    /// Jellyfin routes <c>/LiveStreams/Open</c> tokens to a provider by an
    /// MD5-of-provider-type-name prefix that <c>MediaSourceManager.SetKeyProperties</c> adds to
    /// dynamic sources. Sources projected into item DTOs bypass that host step, so the same
    /// prefix must be applied here or DTO tokens would be unroutable at open time.
    /// </summary>
    internal static readonly string HostOpenTokenPrefix =
        typeof(StreamarrMediaSourceProvider).FullName!
            .GetMD5()
            .ToString("N", CultureInfo.InvariantCulture) + "_";

    /// <summary>Applies the host routing prefix exactly once, mirroring the host's own check.</summary>
    internal static string WithHostOpenTokenPrefix(string openToken)
        => openToken.StartsWith(HostOpenTokenPrefix, StringComparison.OrdinalIgnoreCase)
            ? openToken
            : HostOpenTokenPrefix + openToken;

    /// <summary>
    /// Official clients treat the media-source id of a multi-version item as an item id:
    /// Jellyfin Web fetches <c>/Users/{uid}/Items/{mediaSourceId}</c> before playing a selected
    /// version and Android TV parses the id as a UUID outright. Release sources therefore expose
    /// a deterministic, GUID-shaped id derived from (workId, releaseId) instead of the raw Core
    /// release id, and <see cref="TryResolveReleaseSource"/> maps it back to the owning item.
    /// </summary>
    internal static Guid ReleaseSourceGuid(string workId, string releaseId)
        => $"streamarr-release:{workId}:{releaseId}".GetMD5();

    /// <summary>The "N"-formatted form Jellyfin uses for item-backed media-source ids.</summary>
    internal static string ReleaseSourceId(string workId, string releaseId)
        => ReleaseSourceGuid(workId, releaseId).ToString("N", CultureInfo.InvariantCulture);

    /// <summary>Cheap precheck so response fixups can skip native items without a library lookup.</summary>
    public bool Owns(Guid itemId) => itemId != Guid.Empty && store.Peek(itemId) is not null;

    /// <summary>Resolves a release-source guid back to the item whose work offers that release.</summary>
    public bool TryResolveReleaseSource(Guid sourceId, out Guid itemId)
    {
        itemId = Guid.Empty;
        if (sourceId == Guid.Empty)
            return false;

        foreach (var entry in store.All())
        {
            foreach (var release in entry.Work.Releases)
            {
                if (ReleaseSourceGuid(entry.Work.WorkId, release.ReleaseId) == sourceId)
                {
                    itemId = entry.ItemId;
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Tries to project a plugin-owned work. A successful projection may contain zero sources
    /// when Core returned no releases; <see langword="false"/> means the item is not backed by
    /// Streamarr release state and its native Jellyfin sources must remain untouched.
    /// Visibility follows <paramref name="user"/> (the request's target user) while the one-use
    /// offers stay bound to <paramref name="offerOwnerId"/> (the authenticated caller), so an
    /// admin viewing another user's page never mints tokens it cannot redeem.
    /// </summary>
    public bool TryProject(
        BaseItem item,
        User? user,
        Guid offerOwnerId,
        out IReadOnlyList<MediaSourceInfo> sources)
    {
        ArgumentNullException.ThrowIfNull(item);
        sources = [];

        var entry = store.Get(item.Id);
        if (entry is null || entry.ItemId != item.Id)
            return false;

        if (user is null || offerOwnerId == Guid.Empty)
        {
            logger.LogDebug(
                "Declining Streamarr media sources for item {ItemId}: no authenticated Jellyfin user",
                item.Id);
            return true;
        }

        if (!item.IsVisibleStandalone(user))
        {
            logger.LogDebug(
                "Declining Streamarr media sources for item {ItemId}: item is not visible to user {UserId}",
                item.Id,
                user.Id);
            return true;
        }

        if (entry.Work.Releases.Count == 0)
        {
            logger.LogDebug(
                "Declining Streamarr media sources for item {ItemId}: Core returned no releases",
                item.Id);
            return true;
        }

        var capabilities = offers.CreateOffers(
            item.Id,
            offerOwnerId,
            entry.Work.WorkId,
            entry.Work.Releases.Select(release => release.ReleaseId).ToArray());
        sources = entry.Work.Releases
            .Where(release => capabilities.ContainsKey(release.ReleaseId))
            .Select(release =>
            {
                var source = MediaSourceMapper.ToUnopenedSource(release, capabilities[release.ReleaseId]);
                source.Id = ReleaseSourceId(entry.Work.WorkId, release.ReleaseId);
                return source;
            })
            .ToArray();
        logger.LogDebug("Offering {Count} Streamarr versions for item {ItemId}", sources.Count, item.Id);
        return true;
    }
}
