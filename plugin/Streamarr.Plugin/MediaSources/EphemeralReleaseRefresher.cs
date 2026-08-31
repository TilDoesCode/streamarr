using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.MediaSources;

/// <summary>
/// Keeps cached release lists fresh without turning Jellyfin list and playback requests into
/// unbounded Core search fan-out. Background refreshes are coalesced by work id and drained by one
/// worker; foreground recovery has its own single-flight lane so playback is never trapped behind
/// a season-sized backlog.
/// </summary>
public sealed class EphemeralReleaseRefresher(
    EphemeralReleaseStore store,
    StreamarrApiClient api,
    ILogger<EphemeralReleaseRefresher> logger) : IHostedService, IDisposable
{
    internal const int BackgroundQueueCapacity = 8;
    internal static readonly TimeSpan MinRetryInterval = TimeSpan.FromSeconds(60);
    internal static readonly TimeSpan RefreshTimeout = TimeSpan.FromSeconds(5);
    internal static readonly TimeSpan ForegroundRefreshTimeout = TimeSpan.FromSeconds(120);

    private readonly Channel<string> _background = Channel.CreateBounded<string>(
        new BoundedChannelOptions(BackgroundQueueCapacity)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
        });
    private readonly ConcurrentDictionary<string, byte> _queued = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DateTime> _lastAttemptUtc = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<bool>>> _foreground = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _workGates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _foregroundGate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private Task? _drain;
    private int _started;
    private int _stopping;

    internal int QueuedWorkCount => _queued.Count;

    /// <summary>An entry with no releases is always considered stale, subject to the retry floor.</summary>
    internal static bool NeedsRefresh(EphemeralReleaseStore.Entry entry, DateTime nowUtc, TimeSpan ttl)
        => entry.Work.Releases.Count == 0 || nowUtc - entry.LastRefreshedUtc > ttl;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _started, 1) == 0)
            _drain = Task.Run(() => DrainAsync(_stop.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _stopping, 1) != 0)
            return;

        _background.Writer.TryComplete();
        await _stop.CancelAsync().ConfigureAwait(false);
        var tasks = _foreground.Values
            .Where(value => value.IsValueCreated)
            .Select(value => value.Value)
            .Append(_drain ?? Task.CompletedTask)
            .ToArray();
        try
        {
            await Task.WhenAll(tasks).WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            _queued.Clear();
        }
    }

    /// <summary>
    /// Enqueues a stale item without delaying the Jellyfin response. Returns false when the item
    /// is fresh, unknown, stopping, or the small background queue is full.
    /// </summary>
    public bool QueueIfStale(Guid itemId)
    {
        if (Volatile.Read(ref _started) == 0 || Volatile.Read(ref _stopping) != 0)
            return false;
        var entry = store.Peek(itemId);
        if (entry is null || !NeedsRefresh(entry, DateTime.UtcNow, ConfiguredTtl()))
            return false;
        var workId = entry.Work.WorkId;
        if (_queued.ContainsKey(workId))
            return true;
        if (RecentlyAttempted(workId, DateTime.UtcNow))
            return false;
        if (!_queued.TryAdd(workId, 0))
            return true;
        if (_background.Writer.TryWrite(workId))
            return true;
        _queued.TryRemove(workId, out _);
        return false;
    }

    /// <summary>
    /// Awaitable stale refresh retained for explicit callers and tests. It is coalesced by work id
    /// and bounded independently from the background queue.
    /// </summary>
    public async Task RefreshIfStaleAsync(Guid itemId, CancellationToken ct)
    {
        var entry = store.Peek(itemId);
        if (entry is null || !NeedsRefresh(entry, DateTime.UtcNow, ConfiguredTtl()))
            return;
        if (RecentlyAttempted(entry.Work.WorkId, DateTime.UtcNow))
            return;
        await AwaitForegroundAsync(entry.Work.WorkId, itemId, entry, ct).ConfigureAwait(false);
    }

    /// <summary>Forces one coalesced refresh when Core lost a persisted playback release.</summary>
    public async Task<WorkDto?> RefreshForPlaybackAsync(Guid itemId, CancellationToken ct)
    {
        var entry = store.Peek(itemId);
        if (entry is null)
            return null;
        if (!await AwaitForegroundAsync(entry.Work.WorkId, itemId, entry, ct).ConfigureAwait(false))
            return null;
        var current = store.Peek(itemId);
        return current is not null
               && string.Equals(current.Work.WorkId, entry.Work.WorkId, StringComparison.Ordinal)
            ? current.Work
            : null;
    }

    /// <summary>Unconditionally and sequentially refreshes every cached work.</summary>
    public async Task<int> RefreshAllNowAsync(CancellationToken ct)
    {
        var refreshed = 0;
        foreach (var workId in store.All()
                     .Select(entry => entry.Work.WorkId)
                     .Distinct(StringComparer.Ordinal))
        {
            ct.ThrowIfCancellationRequested();
            _lastAttemptUtc.TryRemove(workId, out _);
            if (await AwaitForegroundAsync(
                    workId,
                    expectedItemId: null,
                    expectedEntry: null,
                    ct)
                .ConfigureAwait(false))
                refreshed++;
        }
        return refreshed;
    }

    private async Task DrainAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var workId in _background.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    await RefreshWorkAsync(
                            workId,
                            force: false,
                            timeoutDuration: RefreshTimeout,
                            expectedItemId: null,
                            expectedEntry: null,
                            ct: ct)
                        .ConfigureAwait(false);
                }
                finally
                {
                    _queued.TryRemove(workId, out _);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
    }

    private async Task<bool> AwaitForegroundAsync(
        string workId,
        Guid? expectedItemId,
        EphemeralReleaseStore.Entry? expectedEntry,
        CancellationToken ct)
    {
        var pending = _foreground.GetOrAdd(
            workId,
            id => new Lazy<Task<bool>>(
                () => RunForegroundAsync(id, expectedItemId, expectedEntry),
                LazyThreadSafetyMode.ExecutionAndPublication));
        var shared = pending.Value;
        _ = shared.ContinueWith(
            _ => _foreground.TryRemove(new KeyValuePair<string, Lazy<Task<bool>>>(workId, pending)),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        return await shared.WaitAsync(ct).ConfigureAwait(false);
    }

    private async Task<bool> RunForegroundAsync(
        string workId,
        Guid? expectedItemId,
        EphemeralReleaseStore.Entry? expectedEntry)
    {
        await _foregroundGate.WaitAsync(_stop.Token).ConfigureAwait(false);
        try
        {
            return await RefreshWorkAsync(
                    workId,
                    force: true,
                    timeoutDuration: ForegroundRefreshTimeout,
                    expectedItemId: expectedItemId,
                    expectedEntry: expectedEntry,
                    ct: _stop.Token)
                .ConfigureAwait(false);
        }
        finally
        {
            _foregroundGate.Release();
        }
    }

    private async Task<bool> RefreshWorkAsync(
        string workId,
        bool force,
        TimeSpan timeoutDuration,
        Guid? expectedItemId,
        EphemeralReleaseStore.Entry? expectedEntry,
        CancellationToken ct)
    {
        var workGate = _workGates.GetOrAdd(workId, static _ => new SemaphoreSlim(1, 1));
        await workGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (expectedItemId is { } itemId && expectedEntry is not null)
            {
                var current = store.Peek(itemId);
                if (!ReferenceEquals(current, expectedEntry))
                {
                    return current is not null
                           && string.Equals(current.Work.WorkId, workId, StringComparison.Ordinal);
                }
            }

            var now = DateTime.UtcNow;
            if (!force && RecentlyAttempted(workId, now))
                return false;
            var candidates = store.All()
                .Where(entry => string.Equals(entry.Work.WorkId, workId, StringComparison.Ordinal))
                .ToArray();
            var source = candidates.FirstOrDefault();
            if (source is null)
                return false;

            _lastAttemptUtc[workId] = now;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(timeoutDuration);
            SearchResponse? refreshed;
            try
            {
                refreshed = await api.RefreshWorkAsync(source.Work, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                logger.LogDebug(
                    ex,
                    "Streamarr release refresh failed for work {WorkId} ({FailureType})",
                    workId,
                    ex.GetType().Name);
                return false;
            }

            var match = refreshed?.Results.FirstOrDefault(result =>
                string.Equals(result.WorkId, workId, StringComparison.Ordinal));
            if (match is null)
                return false;

            var updated = false;
            foreach (var candidate in candidates)
                updated |= store.TryUpdateIfCurrent(candidate, match);
            if (!updated && expectedItemId is { } refreshedItemId && expectedEntry is not null)
            {
                var current = store.Peek(refreshedItemId);
                return !ReferenceEquals(current, expectedEntry)
                       && current is not null
                       && string.Equals(current.Work.WorkId, workId, StringComparison.Ordinal);
            }
            return updated;
        }
        finally
        {
            workGate.Release();
        }
    }

    private bool RecentlyAttempted(string workId, DateTime now)
        => _lastAttemptUtc.TryGetValue(workId, out var last) && now - last < MinRetryInterval;

    private static TimeSpan ConfiguredTtl() => TimeSpan.FromMinutes(
        Plugin.Instance?.Configuration.ReleaseCacheTtlMinutes ?? 30);

    public void Dispose()
    {
        Interlocked.Exchange(ref _stopping, 1);
        _background.Writer.TryComplete();
        _stop.Cancel();
        _stop.Dispose();
        _foregroundGate.Dispose();
    }
}
