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

    internal async Task FlushAsync(CancellationToken ct)
    {
        Dictionary<string, (long Bytes, DateTimeOffset At)> batch;
        lock (_lock)
        {
            if (_pending.Count == 0)
                return;
            (batch, _pending) = (_pending, new Dictionary<string, (long, DateTimeOffset)>(StringComparer.Ordinal));
        }
        foreach (var (downloadId, (bytes, at)) in batch)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(WriteTimeout);
                await using var db = await dbFactory.CreateDbContextAsync(timeout.Token);
                var atMs = at.ToUnixTimeMilliseconds();
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""UPDATE "ViewerDownloads" SET "BytesServed" = "BytesServed" + {bytes}, "LastTransferAt" = {atMs} WHERE "Id" = {downloadId}""", timeout.Token);
            }
            catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                lock (_lock)
                    Merge(_pending, downloadId, bytes, at);
                logger.LogDebug(e, "Recording the bytes of download {DownloadId} failed; trying again later", downloadId);
            }
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await _wake.WaitAsync(FlushInterval, stoppingToken);
                await FlushAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        using var last = new CancellationTokenSource(WriteTimeout);
        await FlushAsync(last.Token);
    }

    private static void Merge(Dictionary<string, (long Bytes, DateTimeOffset At)> pending, string downloadId, long bytes, DateTimeOffset at)
        => pending[downloadId] = pending.TryGetValue(downloadId, out var known)
            ? (known.Bytes + bytes, known.At > at ? known.At : at)
            : (bytes, at);
}
