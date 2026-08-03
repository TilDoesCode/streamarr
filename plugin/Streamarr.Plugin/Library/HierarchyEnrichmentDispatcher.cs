using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Streamarr.Plugin.Library;

public sealed class HierarchyEnrichmentDispatcher(
    ILogger<HierarchyEnrichmentDispatcher> logger) : IHostedService, IDisposable
{
    private const int Capacity = 128;
    private readonly record struct WorkItem(string Key, Func<CancellationToken, Task> Run);

    private readonly Channel<WorkItem> _queue = Channel.CreateBounded<WorkItem>(
        new BoundedChannelOptions(Capacity)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
        });
    private readonly ConcurrentDictionary<string, byte> _pending = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _stop = new();
    private Task? _drain;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _drain = Task.Run(() => DrainAsync(_stop.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _queue.Writer.TryComplete();
        await _stop.CancelAsync().ConfigureAwait(false);
        if (_drain is not { } drain)
            return;
        try
        {
            await drain.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
    }

    public bool Enqueue(string key, Func<CancellationToken, Task> work)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(work);
        if (!_pending.TryAdd(key, 0))
            return true;
        if (_queue.Writer.TryWrite(new WorkItem(key, work)))
            return true;
        _pending.TryRemove(key, out _);
        logger.LogWarning("Dropped deferred hierarchy enrichment {EnrichmentKey}: queue is full", key);
        return false;
    }

    private async Task DrainAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var item in _queue.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    await item.Run(ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Deferred hierarchy enrichment {EnrichmentKey} failed", item.Key);
                }
                finally
                {
                    _pending.TryRemove(item.Key, out _);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
    }

    public void Dispose() => _stop.Dispose();
}
