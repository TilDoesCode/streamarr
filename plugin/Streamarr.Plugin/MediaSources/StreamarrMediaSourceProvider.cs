using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
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
    StreamarrApiClient api,
    ILogger<StreamarrMediaSourceProvider> logger) : IMediaSourceProvider
{
    public Task<IEnumerable<MediaSourceInfo>> GetMediaSources(BaseItem item, CancellationToken cancellationToken)
    {
        var releases = store.ReleasesFor(item.Id);
        if (releases.Count == 0)
            return Task.FromResult(Enumerable.Empty<MediaSourceInfo>());

        var sources = releases.Select(MediaSourceMapper.ToUnopenedSource).ToList();
        logger.LogDebug("Offering {Count} Streamarr versions for item {ItemId}", sources.Count, item.Id);
        return Task.FromResult<IEnumerable<MediaSourceInfo>>(sources);
    }

    public async Task<ILiveStream> OpenMediaSource(
        string openToken,
        List<ILiveStream> currentLiveStreams,
        CancellationToken cancellationToken)
    {
        var resolve = await ResolveWithFallbackAsync(openToken, cancellationToken).ConfigureAwait(false);

        var liveStreamId = Guid.NewGuid().ToString("N");
        var token = StreamarrApiClient.TokenFromStreamUrl(resolve.StreamUrl);
        var source = MediaSourceMapper.ToOpenedSource(resolve, liveStreamId, api.ApiKey);
        var stream = new StreamarrLiveStream(source, token, api, logger);
        currentLiveStreams.Add(stream);

        // Remember which release this opened source represents so playback events can be
        // attributed to it. Both the live-stream id and the resolved release id are keyed.
        var workId = store.FindByReleaseId(resolve.ReleaseId)?.Work.WorkId;
        tracker.Track(liveStreamId, resolve.ReleaseId, workId);
        tracker.Track(resolve.ReleaseId, resolve.ReleaseId, workId);
        logger.LogInformation(
            "Opened Streamarr release {ReleaseId} (status={Status}) as live stream {LiveStreamId}",
            resolve.ReleaseId, resolve.Status, liveStreamId);
        return stream;
    }

    /// <summary>
    /// Resolves <paramref name="releaseId"/>; if the server reports it dead, follows the
    /// <c>suggestedFallbackReleaseId</c> once (BRIEF §8.4). The plugin never picks the
    /// fallback itself — it only obeys the server's suggestion.
    /// </summary>
    private async Task<ResolveResponse> ResolveWithFallbackAsync(string releaseId, CancellationToken ct)
    {
        var resolve = await api.ResolveAsync(releaseId, ct).ConfigureAwait(false)
                      ?? throw new InvalidOperationException($"Empty resolve response for release {releaseId}.");

        if (!IsDead(resolve))
            return resolve;

        var fallback = resolve.SuggestedFallbackReleaseId;
        if (string.IsNullOrWhiteSpace(fallback))
            throw new InvalidOperationException($"Release {releaseId} is dead and the server offered no fallback.");

        logger.LogInformation("Release {ReleaseId} dead; following server fallback {Fallback}", releaseId, fallback);
        var second = await api.ResolveAsync(fallback, ct).ConfigureAwait(false)
                     ?? throw new InvalidOperationException($"Empty resolve response for fallback {fallback}.");

        if (IsDead(second))
            throw new InvalidOperationException($"Release {releaseId} and its fallback {fallback} are both dead.");

        return second;
    }

    private static bool IsDead(ResolveResponse resolve)
        => string.Equals(resolve.Status, "dead", StringComparison.OrdinalIgnoreCase)
           || string.IsNullOrWhiteSpace(resolve.StreamUrl);
}
