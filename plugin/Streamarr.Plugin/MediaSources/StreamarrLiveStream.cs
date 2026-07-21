using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Playback;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// A live stream backed by a Core Server session. The heavy lifting (open/probe) already
/// happened in <c>/resolve</c>, so <see cref="Open"/> is a no-op. Jellyfin close callbacks only
/// release plugin-side attribution: clients can briefly close/reopen a source while playback is
/// still buffered, so Core owns capability eviction through its LRU byte budget and hard TTL.
/// Playback bytes flow directly from the HTTP <c>Path</c> on the <see cref="MediaSource"/>, so
/// <see cref="GetStream"/> is never used.
/// </summary>
public sealed class StreamarrLiveStream(
    MediaSourceInfo mediaSource,
    PlaybackSessionTracker tracker,
    ILogger logger,
    Action? releaseOffer = null) : ILiveStream
{
    private int _closeQueued;

    // MediaSourceManager decrements this on CloseLiveStream and closes at zero. This provider
    // creates exclusive streams, so every newly opened instance starts with one consumer.
    public int ConsumerCount { get; set; } = 1;

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

        // The OpenToken replay window begins when this live use ends, not when PlaybackInfo was
        // first fetched. This also reference-counts concurrent opens of the same cached token.
        releaseOffer?.Invoke();

        // Jellyfin prefixes MediaSource.LiveStreamId after the provider returns. UniqueId captures
        // the provider-issued id at construction time and remains stable for tracker lookup.
        tracker.Forget(UniqueId);
        logger.LogDebug("Released Streamarr playback attribution; Core retained the ephemeral file");
    }
}
