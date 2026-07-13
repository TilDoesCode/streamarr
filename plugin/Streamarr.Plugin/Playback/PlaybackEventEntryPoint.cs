using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Bridges Jellyfin's playback session events to <c>POST /api/v1/events</c> (BRIEF §8.4)
/// so watch state escapes Jellyfin's DB into the Core Server. Only events for our
/// ephemeral items are forwarded; everything else is ignored. Errors are swallowed —
/// event reporting must never disrupt playback.
/// </summary>
public sealed class PlaybackEventEntryPoint(
    ISessionManager sessionManager,
    PlaybackSessionTracker tracker,
    EphemeralReleaseStore store,
    StreamarrApiClient api,
    ILogger<PlaybackEventEntryPoint> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        sessionManager.PlaybackStart += OnPlaybackStart;
        sessionManager.PlaybackProgress += OnPlaybackProgress;
        sessionManager.PlaybackStopped += OnPlaybackStopped;
        logger.LogInformation("Streamarr playback event reporter attached");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        sessionManager.PlaybackStart -= OnPlaybackStart;
        sessionManager.PlaybackProgress -= OnPlaybackProgress;
        sessionManager.PlaybackStopped -= OnPlaybackStopped;
        return Task.CompletedTask;
    }

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e) => Report("start", e);

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e) => Report("progress", e);

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
    {
        Report("stop", e);
        tracker.Forget(e.MediaSourceId);
    }

    private void Report(string kind, PlaybackProgressEventArgs e)
    {
        var item = e.Item;
        if (item is null)
            return;

        // Only forward events for our ephemeral items.
        var entry = store.Get(item.Id);
        var attribution = tracker.Resolve(e.MediaSourceId);
        if (entry is null && attribution is null)
            return;

        var releaseId = attribution?.ReleaseId ?? e.MediaSourceId;
        if (string.IsNullOrWhiteSpace(releaseId))
            return;

        var request = new EventRequest
        {
            ReleaseId = releaseId,
            WorkId = attribution?.WorkId ?? entry?.Work.WorkId,
            Event = kind,
            PositionTicks = e.PlaybackPositionTicks,
            Source = "jellyfin",
        };

        // Fire and forget — never block or throw into Jellyfin's event pipeline.
        _ = ReportAsync(request);
    }

    private async Task ReportAsync(EventRequest request)
    {
        try
        {
            await api.ReportEventAsync(request, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to report playback event {Event} for {ReleaseId}", request.Event, request.ReleaseId);
        }
    }
}
