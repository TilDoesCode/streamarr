using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Bridges Jellyfin playback callbacks to a bounded, drained Core delivery queue. Only events for
/// plugin-owned ephemeral items are accepted, and callback threads never perform network I/O.
/// </summary>
public sealed class PlaybackEventEntryPoint(
    ISessionManager sessionManager,
    PlaybackSessionTracker tracker,
    EphemeralReleaseStore store,
    PlaybackEventDispatcher dispatcher,
    ILogger<PlaybackEventEntryPoint> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        dispatcher.Start();
        sessionManager.PlaybackStart += OnPlaybackStart;
        sessionManager.PlaybackProgress += OnPlaybackProgress;
        sessionManager.PlaybackStopped += OnPlaybackStopped;
        logger.LogInformation("Streamarr playback event reporter attached");
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        sessionManager.PlaybackStart -= OnPlaybackStart;
        sessionManager.PlaybackProgress -= OnPlaybackProgress;
        sessionManager.PlaybackStopped -= OnPlaybackStopped;
        await dispatcher.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e) => Report("start", e);

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e) => Report("progress", e);

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        var attribution = Report("stop", e);
        if (attribution?.SessionToken is { } token && dispatcher.EnqueueClose(token))
            tracker.Forget(e.MediaSourceId);
    }

    private PlaybackSessionTracker.Attribution? Report(string kind, PlaybackProgressEventArgs e)
    {
        var item = e.Item;
        if (item is null)
            return null;

        // A start marks actual use; progress merely reads the persisted cache so it does not write
        // the state file at Jellyfin's callback frequency.
        var entry = string.Equals(kind, "start", StringComparison.Ordinal)
            ? store.Get(item.Id)
            : store.Peek(item.Id);
        var attribution = tracker.Resolve(e.MediaSourceId);
        if (entry is null && attribution is null)
            return null;

        var releaseId = attribution?.ReleaseId ?? e.MediaSourceId;
        if (string.IsNullOrWhiteSpace(releaseId))
            return attribution;

        var request = new EventRequest
        {
            ReleaseId = releaseId,
            WorkId = attribution?.WorkId ?? entry?.Work.WorkId,
            Event = kind,
            PositionTicks = e.PlaybackPositionTicks,
            Source = "jellyfin",
        };
        var coalesceKey = attribution?.TrackingId.ToString("N") ?? $"{item.Id:N}:{releaseId}";
        if (!dispatcher.EnqueueEvent(request, coalesceKey))
            logger.LogDebug("Dropped Streamarr playback event {Event} for {ReleaseId}", kind, releaseId);
        return attribution;
    }
}
