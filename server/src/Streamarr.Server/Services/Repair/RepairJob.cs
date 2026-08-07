namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Mutable state of one running repair. All transitions are lock-protected; snapshots
/// are cheap immutable copies. Event messages are operator-facing and never contain
/// message-ids, tokens or paths.
/// </summary>
internal sealed class RepairJob
{
    private readonly object _sync = new();
    private readonly TaskCompletionSource<RepairArtifact> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly CancellationTokenSource _cancel = new();
    private readonly Queue<RepairJobEvent> _events;
    private readonly int _maxEvents;
    private readonly TimeProvider _time;

    private RepairState _state = RepairState.None;
    private RepairDisposition _disposition = RepairDisposition.Unknown;
    private long _totalBytes;
    private long _sourceBytes;
    private long _parityBytes;
    private long _reconstructionProcessed;
    private long _reconstructionTotal;
    private int _damagedBlocks;
    private int _recoveryUsed;
    private long _firstDamagedByte = -1;
    private int _waiters;
    private string? _failureReason;
    private DateTimeOffset? _completedAt;
    private readonly DateTimeOffset _createdAt;
    private long _firstByteTimestamp;

    public RepairJob(
        RepairJobContext context,
        string releaseId,
        string? workId,
        string? releaseTitle,
        int maxEvents,
        TimeProvider time)
    {
        Context = context;
        ReleaseId = releaseId;
        WorkId = workId;
        ReleaseTitle = releaseTitle;
        _maxEvents = Math.Max(8, maxEvents);
        _events = new Queue<RepairJobEvent>(_maxEvents);
        _time = time;
        _createdAt = time.GetUtcNow();
        JobId = Guid.NewGuid().ToString("N")[..16];
        _ = _completion.Task.ContinueWith(
            static completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
    }

    public RepairJobContext Context { get; }
    public string JobId { get; }
    public string ReleaseId { get; }
    public string? WorkId { get; }
    public string? ReleaseTitle { get; }
    public string Fingerprint => Context.Fingerprint;
    public Task<RepairArtifact> Completion => _completion.Task;
    public CancellationToken CancelToken => _cancel.Token;

    public void AddWaiter() => Interlocked.Increment(ref _waiters);
    public void RemoveWaiter() => Interlocked.Decrement(ref _waiters);

    public void Cancel(string reason)
    {
        lock (_sync)
        {
            if (IsTerminalLocked())
                return;
            AddEventLocked(reason);
        }
        _cancel.Cancel();
    }

    public void Transition(RepairState state, string message)
    {
        lock (_sync)
        {
            if (IsTerminalLocked())
                return;
            _state = state;
            AddEventLocked(message);
        }
    }

    public void AddEvent(string message)
    {
        lock (_sync)
        {
            AddEventLocked(message);
        }
    }

    public void SetDisposition(RepairDisposition disposition)
    {
        lock (_sync)
        {
            _disposition = disposition;
        }
    }

    public void SetTotals(long totalBytes) => Interlocked.Exchange(ref _totalBytes, totalBytes);

    public void AddSourceBytes(long bytes)
    {
        Interlocked.CompareExchange(ref _firstByteTimestamp, _time.GetTimestamp(), 0);
        Interlocked.Add(ref _sourceBytes, bytes);
    }

    public void AddParityBytes(long bytes) => Interlocked.Add(ref _parityBytes, bytes);
    public void SetDamage(int damagedBlocks) => Interlocked.Exchange(ref _damagedBlocks, damagedBlocks);

    public void SetFirstDamagedByte(long offset) => Interlocked.Exchange(ref _firstDamagedByte, offset);
    public void SetRecoveryUsed(int used) => Interlocked.Exchange(ref _recoveryUsed, used);

    public void SetReconstruction(long processed, long total)
    {
        Interlocked.Exchange(ref _reconstructionProcessed, processed);
        Interlocked.Exchange(ref _reconstructionTotal, total);
    }

    public void Succeed(RepairArtifact artifact)
    {
        lock (_sync)
        {
            if (IsTerminalLocked())
                return;
            _state = RepairState.Ready;
            _disposition = RepairDisposition.Repairable;
            _completedAt = _time.GetUtcNow();
            AddEventLocked("artifact verified and published");
        }
        _completion.TrySetResult(artifact);
    }

    public void Fail(RepairDisposition disposition, string reason)
    {
        lock (_sync)
        {
            if (IsTerminalLocked())
                return;
            _state = RepairState.Failed;
            _disposition = disposition;
            _failureReason = reason;
            _completedAt = _time.GetUtcNow();
            AddEventLocked($"failed: {reason}");
        }
        _completion.TrySetException(new RepairFailedException(disposition, reason));
    }

    public void SetCancelled()
    {
        lock (_sync)
        {
            if (IsTerminalLocked())
                return;
            _state = RepairState.Cancelled;
            _completedAt = _time.GetUtcNow();
            AddEventLocked("cancelled");
        }
        _completion.TrySetException(new RepairFailedException(RepairDisposition.Unknown, "cancelled"));
    }

    public bool SetEvicted()
    {
        lock (_sync)
        {
            if (_state != RepairState.Ready)
                return false;
            _state = RepairState.Evicted;
            AddEventLocked("artifact evicted");
            return true;
        }
    }

    public RepairJobSnapshot Snapshot()
    {
        lock (_sync)
        {
            var source = Interlocked.Read(ref _sourceBytes);
            var parity = Interlocked.Read(ref _parityBytes);
            var total = Interlocked.Read(ref _totalBytes);
            double? eta = null;
            var firstByte = Interlocked.Read(ref _firstByteTimestamp);
            if (firstByte != 0 && source > 0 && total > source)
            {
                var elapsed = _time.GetElapsedTime(firstByte).TotalSeconds;
                if (elapsed > 1)
                    eta = (total - source) / (source / elapsed);
            }

            return new RepairJobSnapshot
            {
                JobId = JobId,
                Fingerprint = Fingerprint,
                ReleaseId = ReleaseId,
                WorkId = WorkId,
                ReleaseTitle = ReleaseTitle,
                Disposition = _disposition,
                State = _state,
                CreatedAtUtc = _createdAt,
                CompletedAtUtc = _completedAt,
                ProcessedBytes = source + parity,
                TotalBytes = total,
                SourceBytesDownloaded = source,
                ParityBytesDownloaded = parity,
                DamagedBlocks = _damagedBlocks,
                RecoveryBlocksUsed = _recoveryUsed,
                FirstDamagedByte = Interlocked.Read(ref _firstDamagedByte) is var first && first >= 0 ? first : null,
                Waiters = Volatile.Read(ref _waiters),
                FailureReason = _failureReason,
                EtaSeconds = eta,
                Events = [.. _events],
            };
        }
    }

    private bool IsTerminalLocked()
        => _state is RepairState.Ready or RepairState.Failed or RepairState.Cancelled or RepairState.Evicted;

    private void AddEventLocked(string message)
    {
        if (_events.Count >= _maxEvents)
            _events.Dequeue();
        _events.Enqueue(new RepairJobEvent(_time.GetUtcNow(), _state, message));
    }
}

/// <summary>Terminal failure of a repair job, carrying the classified disposition.</summary>
public sealed class RepairFailedException(RepairDisposition disposition, string reason)
    : Exception($"Repair failed ({disposition}): {reason}")
{
    public RepairDisposition Disposition { get; } = disposition;
}
