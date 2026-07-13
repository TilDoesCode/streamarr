using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;

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
    StreamarrApiClient api,
    ILogger logger) : ILiveStream
{
    public int ConsumerCount { get; set; }

    public string? OriginalStreamId { get; set; }

    public string TunerHostId => "streamarr";

    public bool EnableStreamSharing => false;

    public MediaSourceInfo MediaSource { get; set; } = mediaSource;

    public string UniqueId { get; } = mediaSource.LiveStreamId ?? Guid.NewGuid().ToString("N");

    public Task Open(CancellationToken openCancellationToken) => Task.CompletedTask;

    public async Task Close()
    {
        if (string.IsNullOrWhiteSpace(streamToken))
            return;
        try
        {
            await api.CloseSessionAsync(streamToken, CancellationToken.None).ConfigureAwait(false);
            logger.LogInformation("Closed Streamarr session {Token}", streamToken);
        }
        catch (Exception ex)
        {
            // Session close is best-effort; the server also reaps sessions on TTL.
            logger.LogWarning(ex, "Failed to close Streamarr session {Token}", streamToken);
        }
    }

    public Stream GetStream()
        => throw new NotSupportedException("Streamarr streams are consumed via the remote HTTP path, not a direct stream.");

    public void Dispose()
    {
        // Nothing unmanaged to release; session teardown happens in Close().
    }
}
