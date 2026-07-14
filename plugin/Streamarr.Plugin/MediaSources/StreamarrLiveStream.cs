using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// A live stream backed by a Core Server session. The heavy lifting (open/probe) already
/// happened in <c>/resolve</c>, so <see cref="Open"/> is a no-op; <see cref="Close"/> is
/// the <c>CloseLiveStream</c> hook that tears the session down via
/// <c>POST /api/v1/sessions/{token}/close</c> (BRIEF §8.4). Playback bytes flow directly
/// from the HTTP <c>Path</c> on the <see cref="MediaSource"/>, so <see cref="GetStream"/>
/// is never used.
/// </summary>
public sealed class StreamarrLiveStream(
    MediaSourceInfo mediaSource,
    string? streamToken,
    PlaybackEventDispatcher dispatcher,
    PlaybackSessionTracker tracker,
    ILogger logger) : ILiveStream
{
    private int _closeQueued;

    public int ConsumerCount { get; set; }

    public string? OriginalStreamId { get; set; }

    public string TunerHostId => "streamarr";

    public bool EnableStreamSharing => false;

    public MediaSourceInfo MediaSource { get; set; } = mediaSource;

    public string UniqueId { get; } = mediaSource.LiveStreamId ?? Guid.NewGuid().ToString("N");

    public Task Open(CancellationToken openCancellationToken) => Task.CompletedTask;

    public Task Close()
    {
        QueueClose();
        return Task.CompletedTask;
    }

    public Stream GetStream()
        => throw new NotSupportedException("Streamarr streams are consumed via the remote HTTP path, not a direct stream.");

    public void Dispose()
    {
        QueueClose();
    }

    private void QueueClose()
    {
        if (Interlocked.CompareExchange(ref _closeQueued, 1, 0) != 0)
            return;

        // A playback-stop callback may already have queued and forgotten this attribution.
        // Jellyfin prefixes MediaSource.LiveStreamId after the provider returns. UniqueId captures
        // the provider-issued id at construction time and remains stable for tracker lookup.
        if (tracker.Resolve(UniqueId) is null)
            return;

        if (string.IsNullOrWhiteSpace(streamToken) || dispatcher.EnqueueClose(streamToken))
        {
            tracker.Forget(UniqueId);
            logger.LogDebug("Queued a Streamarr capability session for closure");
            return;
        }

        // Keep attribution so scheduled cleanup can retry instead of silently stranding a Core
        // session when the bounded close queue is momentarily saturated.
        Volatile.Write(ref _closeQueued, 0);
        logger.LogWarning("Could not queue a Streamarr capability session for closure; cleanup will retry");
    }
}
