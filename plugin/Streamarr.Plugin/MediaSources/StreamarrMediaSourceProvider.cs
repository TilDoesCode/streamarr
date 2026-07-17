using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Lazy media-source resolution for ephemeral works (BRIEF §8.4). This is the plugin's
/// core adapter surface and still contains ZERO domain logic:
/// <list type="bullet">
/// <item><see cref="GetMediaSources"/> lists one selectable version per ranked release,
/// with no Usenet contact.</item>
/// <item><see cref="OpenMediaSource"/> calls <c>POST /api/v1/resolve</c> and, on a dead
/// release, follows the server-suggested fallback exactly once.</item>
/// </list>
/// Ranking, health classification and the fallback choice are all the server's.
/// </summary>
public sealed class StreamarrMediaSourceProvider(
    EphemeralReleaseStore store,
    PlaybackSessionTracker tracker,
    MediaSourceOfferStore offers,
    StreamarrMediaSourceProjection projection,
    StreamarrApiClient api,
    PlaybackEventDispatcher dispatcher,
    IHttpContextAccessor httpContextAccessor,
    IUserManager userManager,
    ILibraryManager libraryManager,
    ILogger<StreamarrMediaSourceProvider> logger) : IMediaSourceProvider
{
    public Task<IEnumerable<MediaSourceInfo>> GetMediaSources(BaseItem item, CancellationToken cancellationToken)
    {
        var userId = CurrentUserId();
        var user = userId == Guid.Empty ? null : userManager.GetUserById(userId);
        projection.TryProject(item, user, userId, out var sources);
        return Task.FromResult<IEnumerable<MediaSourceInfo>>(sources);
    }

    public async Task<ILiveStream> OpenMediaSource(
        string openToken,
        List<ILiveStream> currentLiveStreams,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId();
        if (!offers.TryTake(openToken, userId, out var offer) || offer is null)
            throw new SecurityException("The Streamarr media-source offer is unknown, expired, or belongs to another user.");

        var user = userManager.GetUserById(userId);
        var item = libraryManager.GetItemById(offer.ItemId);
        if (user is null || item is null || !item.IsVisibleStandalone(user))
            throw new SecurityException("The current user can no longer access the offered Streamarr item.");

        var entry = store.Peek(offer.ItemId);
        if (entry is null
            || !string.Equals(entry.Work.WorkId, offer.WorkId, StringComparison.Ordinal)
            || !entry.Work.Releases.Any(release => string.Equals(release.ReleaseId, offer.ReleaseId, StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("The Streamarr media-source offer no longer matches a materialized work.");
        }

        var resolve = await ResolveWithFallbackAsync(
            offer,
            user.Id.ToString("D"),
            user.Username,
            cancellationToken).ConfigureAwait(false);
        resolve = resolve with { StreamUrl = api.ResolveStreamUrl(resolve.StreamUrl) };

        var liveStreamId = Guid.NewGuid().ToString("N");
        var token = StreamarrApiClient.TokenFromStreamUrl(resolve.StreamUrl);
        bool OfferStillValid()
        {
            try
            {
                var currentUser = userManager.GetUserById(userId);
                var currentItem = libraryManager.GetItemById(offer.ItemId);
                var currentEntry = store.Peek(offer.ItemId);
                return currentUser is not null
                       && currentItem is not null
                       && currentItem.IsVisibleStandalone(currentUser)
                       && currentEntry is not null
                       && string.Equals(currentEntry.Work.WorkId, offer.WorkId, StringComparison.Ordinal)
                       && currentEntry.Work.Releases.Any(release => string.Equals(
                           release.ReleaseId,
                           resolve.ReleaseId,
                           StringComparison.Ordinal));
            }
            catch (Exception ex)
            {
                // Admission validation must fail closed without escaping past session cleanup.
                logger.LogDebug(
                    "Could not revalidate resolved Streamarr item {ItemId} ({FailureType})",
                    offer.ItemId,
                    ex.GetType().Name);
                return false;
            }
        }

        // Resolve may take seconds. Cleanup/reconciliation can retire the offered item in
        // that time, so validate again before admitting the newly opened Core session.
        if (!OfferStillValid())
        {
            await CloseRejectedSessionAsync(token, cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException("The resolved Streamarr work was retired before playback could start.");
        }

        // Remember which release this opened source represents so playback events can be
        // attributed to it. Both the live-stream id and the resolved release id are keyed.
        if (!tracker.TryTrackSession(
                offer.ItemId,
                liveStreamId,
                resolve.ReleaseId,
                offer.WorkId,
                token,
                OfferStillValid,
                out _))
        {
            await CloseRejectedSessionAsync(token, cancellationToken).ConfigureAwait(false);

            throw new InvalidOperationException(
                "The Streamarr item was retired or the active playback-session limit was reached.");
        }

        var source = MediaSourceMapper.ToOpenedSource(resolve, liveStreamId);
        var stream = new StreamarrLiveStream(source, token, dispatcher, tracker, logger);
        currentLiveStreams.Add(stream);
        logger.LogInformation(
            "Opened Streamarr release {ReleaseId} (status={Status}) as live stream {LiveStreamId}",
            resolve.ReleaseId, resolve.Status, liveStreamId);
        return stream;
    }

    private async Task CloseRejectedSessionAsync(string? token, CancellationToken cancellationToken)
    {
        if (token is null || dispatcher.EnqueueClose(token))
            return;

        try
        {
            await api.CloseSessionAsync(token, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                "Could not close a Core session rejected during plugin admission ({FailureType})",
                ex.GetType().Name);
        }
    }

    /// <summary>
    /// Resolves the release authorized by <paramref name="offer"/>; if the server reports
    /// it dead, follows <c>suggestedFallbackReleaseId</c> once (BRIEF §8.4). The plugin
    /// never picks the fallback itself and rejects suggestions outside the offered work.
    /// </summary>
    private async Task<ResolveResponse> ResolveWithFallbackAsync(
        MediaSourceOfferStore.Offer offer,
        string requestedById,
        string requestedByName,
        CancellationToken ct)
    {
        var releaseId = offer.ReleaseId;
        var resolve = await api.ResolveAsync(
                releaseId,
                offer.WorkId,
                requestedById,
                requestedByName,
                ct).ConfigureAwait(false)
                      ?? throw new InvalidOperationException($"Empty resolve response for release {releaseId}.");
        EnsureResolveWithinOffer(resolve, releaseId, offer.AllowedReleaseIds);

        if (!IsDead(resolve))
            return resolve;

        var fallback = resolve.SuggestedFallbackReleaseId;
        if (string.IsNullOrWhiteSpace(fallback))
            throw new InvalidOperationException($"Release {releaseId} is dead and the server offered no fallback.");
        if (!offer.AllowedReleaseIds.Contains(fallback))
            throw new InvalidOperationException("Core suggested a fallback outside the offered work.");

        logger.LogInformation("Release {ReleaseId} dead; following server fallback {Fallback}", releaseId, fallback);
        var second = await api.ResolveAsync(
                fallback,
                offer.WorkId,
                requestedById,
                requestedByName,
                ct).ConfigureAwait(false)
                     ?? throw new InvalidOperationException($"Empty resolve response for fallback {fallback}.");
        EnsureResolveWithinOffer(second, fallback, offer.AllowedReleaseIds);

        if (IsDead(second))
            throw new InvalidOperationException($"Release {releaseId} and its fallback {fallback} are both dead.");

        return second;
    }

    private static bool IsDead(ResolveResponse resolve)
        => string.Equals(resolve.Status, "dead", StringComparison.OrdinalIgnoreCase)
           || string.IsNullOrWhiteSpace(resolve.StreamUrl);

    internal static void EnsureResolveWithinOffer(
        ResolveResponse response,
        string requestedReleaseId,
        IReadOnlySet<string> allowedReleaseIds)
    {
        if (!allowedReleaseIds.Contains(response.ReleaseId))
            throw new InvalidOperationException("Core resolved a release outside the offered work.");

        var changedRelease = !string.Equals(response.ReleaseId, requestedReleaseId, StringComparison.Ordinal);
        if (changedRelease
            && !string.Equals(response.FallbackFromReleaseId, requestedReleaseId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Core changed the offered release without a matching fallback attribution.");
        }

        if (!changedRelease
            && response.FallbackFromReleaseId is not null
            && !string.Equals(response.FallbackFromReleaseId, requestedReleaseId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Core returned inconsistent fallback attribution.");
        }

        if (response.Attempts.Any(attempt => !allowedReleaseIds.Contains(attempt.ReleaseId)))
            throw new InvalidOperationException("Core reported a fallback attempt outside the offered work.");
    }

    private Guid CurrentUserId()
    {
        const string userIdClaimType = "Jellyfin-UserId";
        var claim = httpContextAccessor.HttpContext?.User.Claims.FirstOrDefault(candidate =>
            string.Equals(candidate.Type, userIdClaimType, StringComparison.Ordinal));
        return claim is not null && Guid.TryParse(claim.Value, out var userId) ? userId : Guid.Empty;
    }
}
