using System.Threading.Channels;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Turns deliberate user engagement into library visibility. Search hits materialize below the
/// hidden staging root and stay out of every user view; the first playback start, favorite,
/// watched-mark, or resume position on a plugin-owned item promotes its whole subtree into the
/// visible "Streamarr" library, and removing the last engagement signal (unfavorite plus mark
/// unwatched — available in every Jellyfin client) demotes it again. Because this is a
/// server-side placement change, every client sees the identical library. Event callbacks never
/// touch the library directly: item ids are queued to a single background drain so Jellyfin's
/// save path is never blocked by plugin reparenting work.
/// </summary>
public sealed class EngagementPromotionEntryPoint(
    IUserDataManager userDataManager,
    EphemeralLibraryService library,
    ILogger<EngagementPromotionEntryPoint> logger) : IHostedService, IDisposable
{
    private readonly record struct PlacementUpdate(Guid ItemId, bool Engaged);

    private readonly Channel<PlacementUpdate> _queue = Channel.CreateBounded<PlacementUpdate>(
        new BoundedChannelOptions(512)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.DropWrite,
        });

    private readonly CancellationTokenSource _stop = new();
    private Task? _drain;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        userDataManager.UserDataSaved += OnUserDataSaved;
        _drain = Task.Run(() => DrainAsync(_stop.Token), CancellationToken.None);
        logger.LogInformation("Streamarr engagement placement listener attached");
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        userDataManager.UserDataSaved -= OnUserDataSaved;
        _queue.Writer.TryComplete();
        await _stop.CancelAsync().ConfigureAwait(false);
        if (_drain is { } drain)
        {
            try
            {
                await drain.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Shutdown wins; placement is re-reconciled at next startup/cleanup anyway.
            }
        }
    }

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        var item = e.Item;
        if (item is null || item.IsFolder || !EphemeralLibraryService.IsOwnedFolder(item))
            return;

        // A playback start is a deliberate act even while the position is still 0. Everything
        // else mirrors the persisted engagement predicate used by lifecycle protection.
        var engaged = e.SaveReason == MediaBrowser.Model.Entities.UserDataSaveReason.PlaybackStart
                      || (e.UserData is { } data
                          && (data.PlaybackPositionTicks > 0 || data.IsFavorite || data.Played));
        if (!_queue.Writer.TryWrite(new PlacementUpdate(item.Id, engaged)))
            logger.LogDebug("Dropped engagement placement update for item {ItemId}", item.Id);
    }

    private async Task DrainAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var update in _queue.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    if (update.Engaged)
                        await library.TryPromoteToLibraryAsync(update.ItemId, ct).ConfigureAwait(false);
                    else
                        await library.TryDemoteFromLibraryAsync(update.ItemId, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(
                        ex,
                        "Engagement placement update failed for item {ItemId}; the scheduled cleanup reconciles it later",
                        update.ItemId);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
    }

    public void Dispose() => _stop.Dispose();
}
