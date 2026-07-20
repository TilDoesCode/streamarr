using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// Bounded, single-consumer delivery queue for playback telemetry and session closes. Progress is
/// coalesced per playback so Jellyfin's high-frequency callbacks cannot create unbounded tasks or
/// HTTP requests. Shutdown completes and drains the queue before returning.
/// </summary>
public sealed class PlaybackEventDispatcher
{
    private const int Capacity = 128;
    private const int CloseCapacity = 512;
    private const int CloseAttempts = 3;
    private static readonly TimeSpan OperationTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan CloseRetryDelay = TimeSpan.FromMilliseconds(100);

    private readonly Func<EventRequest, CancellationToken, Task> _sendEvent;
    private readonly Func<string, CancellationToken, Task> _closeSession;
    private readonly ILogger _logger;
    private readonly Channel<WorkItem> _queue = Channel.CreateBounded<WorkItem>(new BoundedChannelOptions(Capacity)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = true,
        SingleWriter = false,
    });
    private readonly ConcurrentDictionary<string, EventRequest> _pendingProgress = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _pendingCloses = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _worker;
    private int _progressSignalQueued;
    private int _closeSignalQueued;
    private int _accepting = 1;

    public PlaybackEventDispatcher(
        Func<EventRequest, CancellationToken, Task> sendEvent,
        Func<string, CancellationToken, Task> closeSession,
        ILogger logger)
    {
        _sendEvent = sendEvent;
        _closeSession = closeSession;
        _logger = logger;
    }

    public PlaybackEventDispatcher(
        StreamarrApiClient api,
        ILogger<PlaybackEventDispatcher> logger)
        : this(api.ReportEventAsync, api.CloseSessionAsync, logger)
    {
    }

    public int PendingProgressCount => _pendingProgress.Count;

    public int PendingCloseCount => _pendingCloses.Count;

    public void Start()
        => _worker ??= Task.Run(RunAsync);

    public bool EnqueueEvent(EventRequest request, string coalesceKey)
    {
        if (Volatile.Read(ref _accepting) == 0)
            return false;

        if (string.Equals(request.Event, "progress", StringComparison.OrdinalIgnoreCase))
        {
            if (!_pendingProgress.ContainsKey(coalesceKey) && _pendingProgress.Count >= Capacity)
                return false;

            _pendingProgress[coalesceKey] = request;
            return SignalProgress();
        }

        if (string.Equals(request.Event, "stop", StringComparison.OrdinalIgnoreCase))
            _pendingProgress.TryRemove(coalesceKey, out _);

        return TryWrite(new WorkItem(WorkKind.Event, request, null));
    }

    public bool EnqueueClose(string? sessionToken)
    {
        if (string.IsNullOrWhiteSpace(sessionToken))
            return true;
        if (Volatile.Read(ref _accepting) == 0)
            return false;
        if (_pendingCloses.ContainsKey(sessionToken))
            return true;
        if (_pendingCloses.Count >= CloseCapacity || !_pendingCloses.TryAdd(sessionToken, 0))
            return _pendingCloses.ContainsKey(sessionToken);

        // Recheck after insertion so StopAsync cannot strand a close between disabling writers
        // and completing the channel.
        if (Volatile.Read(ref _accepting) == 0)
        {
            _pendingCloses.TryRemove(sessionToken, out _);
            return false;
        }

        SignalClose();
        return true;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Interlocked.Exchange(ref _accepting, 0);
        _queue.Writer.TryComplete();
        if (_worker is null)
            return;

        try
        {
            await _worker.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            _shutdown.Cancel();
            throw;
        }
    }

    private bool SignalProgress()
    {
        if (Interlocked.Exchange(ref _progressSignalQueued, 1) != 0)
            return true;

        if (TryWrite(new WorkItem(WorkKind.ProgressSignal, null, null), warnOnFailure: false))
            return true;

        Interlocked.Exchange(ref _progressSignalQueued, 0);
        return false;
    }

    private void SignalClose()
    {
        if (Interlocked.Exchange(ref _closeSignalQueued, 1) != 0)
            return;

        if (!TryWrite(new WorkItem(WorkKind.CloseSignal, null, null), warnOnFailure: false))
            Interlocked.Exchange(ref _closeSignalQueued, 0);
    }

    private bool TryWrite(WorkItem item, bool warnOnFailure = true)
    {
        var accepted = _queue.Writer.TryWrite(item);
        if (!accepted && warnOnFailure)
            _logger.LogWarning("Streamarr playback delivery queue is full; dropping {Kind}", item.Kind);
        return accepted;
    }

    private async Task RunAsync()
    {
        try
        {
            await foreach (var item in _queue.Reader.ReadAllAsync(_shutdown.Token).ConfigureAwait(false))
            {
                switch (item.Kind)
                {
                    case WorkKind.Event when item.Event is not null:
                        await SendEventAsync(item.Event).ConfigureAwait(false);
                        break;
                    case WorkKind.CloseSignal:
                        Interlocked.Exchange(ref _closeSignalQueued, 0);
                        await DrainClosesAsync().ConfigureAwait(false);
                        break;
                    case WorkKind.ProgressSignal:
                        Interlocked.Exchange(ref _progressSignalQueued, 0);
                        await DrainProgressAsync().ConfigureAwait(false);
                        break;
                }

                // A progress update can be retained while its signal cannot enter a full queue.
                // Once the consumer frees a slot, drain that retained update without waiting for
                // another Jellyfin callback (which might never arrive after playback pauses).
                if (!_pendingCloses.IsEmpty && Volatile.Read(ref _closeSignalQueued) == 0)
                    await DrainClosesAsync().ConfigureAwait(false);
                if (!_pendingProgress.IsEmpty && Volatile.Read(ref _progressSignalQueued) == 0)
                    await DrainProgressAsync().ConfigureAwait(false);
            }

            await DrainClosesAsync().ConfigureAwait(false);
            // Progress may have been coalesced while the last signal was being consumed.
            await DrainProgressAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            // Forced host shutdown; best-effort delivery ends here.
        }
    }

    private async Task DrainClosesAsync()
    {
        foreach (var pair in _pendingCloses.ToArray())
        {
            if (((ICollection<KeyValuePair<string, byte>>)_pendingCloses).Remove(pair))
                await CloseSessionAsync(pair.Key).ConfigureAwait(false);
        }

        if (!_pendingCloses.IsEmpty && !_queue.Reader.Completion.IsCompleted)
            SignalClose();
    }

    private async Task DrainProgressAsync()
    {
        foreach (var pair in _pendingProgress.ToArray())
        {
            if (((ICollection<KeyValuePair<string, EventRequest>>)_pendingProgress).Remove(pair))
                await SendEventAsync(pair.Value).ConfigureAwait(false);
        }

        if (!_pendingProgress.IsEmpty && !_queue.Reader.Completion.IsCompleted)
            SignalProgress();
    }

    private async Task SendEventAsync(EventRequest request)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(OperationTimeout);
            await _sendEvent(request, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            _logger.LogDebug(ex, "Failed to report playback event {Event} for {ReleaseId}", request.Event, request.ReleaseId);
        }
    }

    private async Task CloseSessionAsync(string sessionToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        timeout.CancelAfter(OperationTimeout);
        Exception? lastFailure = null;
        var attempts = 0;
        for (var attempt = 1; attempt <= CloseAttempts; attempt++)
        {
            attempts = attempt;
            try
            {
                await _closeSession(sessionToken, timeout.Token).ConfigureAwait(false);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !_shutdown.IsCancellationRequested)
            {
                lastFailure = ex;
                if (attempt == CloseAttempts || timeout.IsCancellationRequested)
                    break;

                try
                {
                    await Task.Delay(CloseRetryDelay, timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!_shutdown.IsCancellationRequested)
                {
                    break;
                }
            }
        }

        if (lastFailure is not null)
            _logger.LogWarning(
                "Failed to close a Streamarr capability session after {Attempts} attempt(s) ({FailureType})",
                attempts,
                lastFailure.GetType().Name);
    }

    private enum WorkKind
    {
        Event,
        ProgressSignal,
        CloseSignal,
    }

    private sealed record WorkItem(WorkKind Kind, EventRequest? Event, string? SessionToken);
}
