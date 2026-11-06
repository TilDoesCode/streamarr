namespace Streamarr.Server.Services;

/// <summary>A FIFO semaphore whose limit is read on every entry, so a settings change applies at once (a lowered limit drains).</summary>
public sealed class DynamicSemaphore(Func<int> limit)
{
    private readonly object _lock = new();
    private readonly LinkedList<TaskCompletionSource> _waiters = new();
    private int _inUse;

    public int InUse => Volatile.Read(ref _inUse);

    public int Limit => Math.Max(1, limit());

    public int Waiting
    {
        get
        {
            lock (_lock)
                return _waiters.Count;
        }
    }

    public Task WaitAsync(CancellationToken ct)
    {
        TaskCompletionSource waiter;
        LinkedListNode<TaskCompletionSource> node;
        lock (_lock)
        {
            if (_inUse < Limit && _waiters.Count == 0)
            {
                _inUse++;
                return Task.CompletedTask;
            }
            waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            node = _waiters.AddLast(waiter);
        }
        if (ct.CanBeCanceled)
        {
            var registration = ct.Register(() =>
            {
                lock (_lock)
                {
                    if (node.List is null)
                        return;
                    _waiters.Remove(node);
                }
                waiter.TrySetCanceled(ct);
            });
            _ = waiter.Task.ContinueWith(_ => registration.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
        return waiter.Task;
    }

    public void Release()
    {
        TaskCompletionSource? next = null;
        lock (_lock)
        {
            if (_waiters.First is { } first && _inUse <= Limit)
            {
                _waiters.RemoveFirst();
                next = first.Value;
            }
            else if (_inUse > 0)
            {
                _inUse--;
            }
        }
        next?.TrySetResult();
    }
}
