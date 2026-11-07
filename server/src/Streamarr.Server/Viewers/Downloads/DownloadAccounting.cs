using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>
/// Bytes served per download, persisted in the background: a transfer only adds to memory, so a busy database never holds up its body,
/// its cancellation or its slot. Writes are best effort with a short timeout; a failed write keeps its bytes for the next round.
/// </summary>
public sealed class DownloadAccounting(IDbContextFactory<StreamarrDbContext> dbFactory, TimeProvider time, ILogger<DownloadAccounting> logger)
    : BackgroundService
{
    internal static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(5);

    private readonly object _lock = new();
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly SemaphoreSlim _flushGate = new(1, 1);
    /// <summary>Failure state of the writer (per write), for the admin download activity.</summary>
    public DownloadMaintenanceTracker Maintenance { get; } = new("accounting", "byte accounting", logger, time);
    private Dictionary<string, (long Bytes, DateTimeOffset At)> _pending = new(StringComparer.Ordinal);

    public void Add(string downloadId, long bytes)
    {
        if (bytes <= 0)
            return;
        var now = time.GetUtcNow();
        lock (_lock)
            Merge(_pending, downloadId, bytes, now);
    }

    /// <summary>Asks for a write soon (a request ended); never waits for it.</summary>
    public void Wake()
    {
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    /// <summary>
    /// Writes the queued bytes, one download at a time. A failed write keeps its bytes for the next round; on cancellation (shutdown)
    /// the current and every unwritten entry go back to the queue before it rethrows, and written ones are never written again.
    /// </summary>
    internal async Task FlushAsync(CancellationToken ct)
    {
        await _flushGate.WaitAsync(CancellationToken.None);
        try
        {
            List<KeyValuePair<string, (long Bytes, DateTimeOffset At)>> batch;
            lock (_lock)
            {
                if (_pending.Count == 0)
                    return;
                batch = [.. _pending];
                _pending = new Dictionary<string, (long, DateTimeOffset)>(StringComparer.Ordinal);
            }
            var next = 0;
            try
            {
                for (; next < batch.Count; next++)
                {
                    var (downloadId, (bytes, at)) = batch[next];
                    try
                    {
                        await WriteAsync(downloadId, bytes, at, ct);
                        Maintenance.Success();
                    }
                    catch (Exception e) when (!(e is OperationCanceledException && ct.IsCancellationRequested))
                    {
                        lock (_lock)
                            Merge(_pending, downloadId, bytes, at);
                        logger.LogDebug(e, "Recording the bytes of download {DownloadId} failed; trying again later", downloadId);
                        Maintenance.Failure(e);
                    }
                }
            }
            catch
            {
                lock (_lock)
                    for (var i = next; i < batch.Count; i++)
                        Merge(_pending, batch[i].Key, batch[i].Value.Bytes, batch[i].Value.At);
                throw;
            }
        }
        finally
        {
            _flushGate.Release();
        }
    }

    private async Task WriteAsync(string downloadId, long bytes, DateTimeOffset at, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(WriteTimeout);
        await using var db = await dbFactory.CreateDbContextAsync(timeout.Token);
        var atMs = at.ToUnixTimeMilliseconds();
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""UPDATE "ViewerDownloads" SET "BytesServed" = "BytesServed" + {bytes}, "LastTransferAt" = {atMs} WHERE "Id" = {downloadId}""", timeout.Token);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _wake.WaitAsync(FlushInterval, stoppingToken);
                await FlushAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                // Never stops the host (StopHost); the bytes stay queued for the next round.
                logger.LogDebug(e, "Recording download bytes failed; trying again");
                Maintenance.Failure(e);
            }
        }
    }

    /// <summary>Stops the loop (a write it had in flight goes back to the queue), then writes everything left with a fresh timeout.</summary>
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        using var last = new CancellationTokenSource(WriteTimeout);
        try
        {
            await FlushAsync(last.Token);
        }
        catch (OperationCanceledException)
        {
            logger.LogWarning("Recording the last download bytes timed out at shutdown");
        }
    }

    private static void Merge(Dictionary<string, (long Bytes, DateTimeOffset At)> pending, string downloadId, long bytes, DateTimeOffset at)
        => pending[downloadId] = pending.TryGetValue(downloadId, out var known)
            ? (known.Bytes + bytes, known.At > at ? known.At : at)
            : (bytes, at);
}
