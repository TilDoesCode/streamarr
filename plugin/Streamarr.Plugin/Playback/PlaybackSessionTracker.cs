using System.Collections.Concurrent;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Maps an opened Jellyfin media-source id (the live-stream id) back to the Core Server
/// releaseId/workId that produced it, so playback events can be attributed to the right
/// release (BRIEF §8.4). Purely a lookup table — no domain logic.
/// </summary>
public sealed class PlaybackSessionTracker
{
    public sealed record Attribution(string ReleaseId, string? WorkId);

    private readonly ConcurrentDictionary<string, Attribution> _byMediaSourceId = new(StringComparer.Ordinal);

    public void Track(string mediaSourceId, string releaseId, string? workId)
        => _byMediaSourceId[mediaSourceId] = new Attribution(releaseId, workId);

    public Attribution? Resolve(string? mediaSourceId)
        => mediaSourceId is not null && _byMediaSourceId.TryGetValue(mediaSourceId, out var a) ? a : null;

    public void Forget(string? mediaSourceId)
    {
        if (mediaSourceId is not null)
            _byMediaSourceId.TryRemove(mediaSourceId, out _);
    }
}
