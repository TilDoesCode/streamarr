// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/Connections/{ConnectionPool,ConnectionLock,ConnectionPoolStats}.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (consolidated; stats event args kept).

using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Streamarr.Usenet.Concurrency;

namespace Streamarr.Usenet.Nntp.Pooling;

public sealed class ConnectionPoolChangedEventArgs(int live, int idle, int max) : EventArgs
{
    public int Live { get; } = live;
    public int Idle { get; } = idle;
    public int Max { get; } = max;
    public int Active => Live - Idle;
}

/// <summary>
/// Thread-safe, lazy connection pool.
/// <para>
/// *  Connections are created through a user-supplied factory (sync or async).<br/>
/// *  At most <c>maxConnections</c> live instances exist at any time.<br/>
/// *  Idle connections older than <see cref="IdleTimeout"/> are disposed
///    automatically by a background sweeper.<br/>
/// *  <see cref="Dispose"/> / <see cref="DisposeAsync"/> stop the sweeper and
///    dispose all cached connections.  Borrowed handles returned afterwards are
///    destroyed immediately.
/// </para>
/// </summary>
public sealed class ConnectionPool<T> : IDisposable, IAsyncDisposable
    where T : class
{
    /* -------------------------------- configuration -------------------------------- */

    public TimeSpan IdleTimeout { get; }
    public int LiveConnections => _live;
    public int IdleConnections => _idleConnections.Count;
    public int ActiveConnections => _live - _idleConnections.Count;
    public int AvailableConnections => _maxConnections - ActiveConnections;

    public event EventHandler<ConnectionPoolChangedEventArgs>? OnConnectionPoolChanged;

    private readonly Func<CancellationToken, ValueTask<T>> _factory;
    private readonly int _maxConnections;

    // NNTP providers silently drop idle connections well before our own IdleTimeout
    // (observed ~2-4 min on commercial servers). A pooled connection idle longer than
    // _revalidateAfter is therefore verified via _validator before being served; a
    // failed probe destroys it and the borrow falls through to the next candidate.
    private readonly Func<T, CancellationToken, ValueTask<bool>>? _validator;
    private readonly TimeSpan _revalidateAfter;

    /* --------------------------------- state --------------------------------------- */

    private readonly ConcurrentStack<Pooled> _idleConnections = new();
    private readonly PrioritizedSemaphore _gate;
    private readonly SemaphoreSlim _warmupGate = new(1, 1);
    private readonly CancellationTokenSource _sweepCts = new();
    private readonly Task _sweeperTask; // keeps timer alive

    private int _live; // number of connections currently alive
    private int _disposed; // 0 == false, 1 == true

    /* ------------------------------------------------------------------------------ */

    public ConnectionPool(
        int maxConnections,
        Func<CancellationToken, ValueTask<T>> connectionFactory,
        TimeSpan? idleTimeout = null,
        Func<T, CancellationToken, ValueTask<bool>>? connectionValidator = null,
        TimeSpan? revalidateAfter = null)
    {
        if (maxConnections <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxConnections));

        _factory = connectionFactory
                   ?? throw new ArgumentNullException(nameof(connectionFactory));
        IdleTimeout = idleTimeout ?? TimeSpan.FromSeconds(30);
        _validator = connectionValidator;
        _revalidateAfter = revalidateAfter ?? TimeSpan.FromSeconds(60);

        _maxConnections = maxConnections;
        _gate = new PrioritizedSemaphore(maxConnections, maxConnections);
        _sweeperTask = Task.Run(SweepLoop); // background idle-reaper
    }

    /* ============================== public API ==================================== */

    /// <summary>
    /// Borrow a connection. Waits on the prioritized gate until capacity is free.
    /// </summary>
    public async Task<ConnectionLock<T>> GetConnectionLockAsync
    (
        SemaphorePriority priority,
        CancellationToken cancellationToken = default
    )
    {
        // Make caller cancellation also cancel the wait on the gate.
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, _sweepCts.Token);

        await _gate.WaitAsync(priority, linked.Token).ConfigureAwait(false);
        return await BuildLockAfterPermitAsync(linked.Token).ConfigureAwait(false);
    }

    private async Task<ConnectionLock<T>> BuildLockAfterPermitAsync(CancellationToken cancellationToken)
    {
        // Pool might have been disposed after wait returned:
        if (Volatile.Read(ref _disposed) == 1)
        {
            _gate.Release();
            ThrowDisposed();
        }

        // Try to reuse an existing idle connection.
        while (_idleConnections.TryPop(out var item))
        {
            if (!item.IsExpired(IdleTimeout))
            {
                bool usable;
                try
                {
                    usable = await IsStillUsableAsync(item, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    // Cancellation mid-probe: the popped connection and the permit
                    // must not leak with the exception.
                    DisposeConnection(item.Connection);
                    Interlocked.Decrement(ref _live);
                    _gate.Release();
                    TriggerConnectionPoolChangedEvent();
                    throw;
                }

                if (usable)
                {
                    TriggerConnectionPoolChangedEvent();
                    return BuildLock(item.Connection, fromIdlePool: true);
                }
            }

            // Stale – destroy and continue looking.
            DisposeConnection(item.Connection);
            Interlocked.Decrement(ref _live);
            TriggerConnectionPoolChangedEvent();
        }

        // Need a fresh connection.
        T conn;
        try
        {
            conn = await _factory(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            _gate.Release(); // free the permit on failure
            throw;
        }

        Interlocked.Increment(ref _live);
        TriggerConnectionPoolChangedEvent();
        return BuildLock(conn, fromIdlePool: false);

        ConnectionLock<T> BuildLock(T c, bool fromIdlePool)
            => new(c, Return, Destroy, fromIdlePool);

        static void ThrowDisposed()
            => throw new ObjectDisposedException(nameof(ConnectionPool<T>));
    }

    /// <summary>
    /// Recently used connections are served as-is; ones idle past the revalidation
    /// threshold are probed first. Probe failures report unusable (never throw) so
    /// the borrow loop can fall through; caller cancellation still propagates.
    /// </summary>
    private async ValueTask<bool> IsStillUsableAsync(Pooled item, CancellationToken cancellationToken)
    {
        if (_validator is null || !item.IsExpired(_revalidateAfter))
            return true;

        try
        {
            return await _validator(item.Connection, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return false;
        }
    }

    private Task<ConnectionLock<T>>? TryStartConnectionLock(CancellationToken cancellationToken)
    {
        CancellationTokenSource? linked = null;
        try
        {
            linked = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken, _sweepCts.Token);
            if (!_gate.TryWait())
            {
                linked.Dispose();
                return null;
            }
        }
        catch (Exception exception)
        {
            linked?.Dispose();
            return Task.FromException<ConnectionLock<T>>(exception);
        }

        return CompleteAsync(linked);

        async Task<ConnectionLock<T>> CompleteAsync(CancellationTokenSource ownedToken)
        {
            using (ownedToken)
                return await BuildLockAfterPermitAsync(ownedToken.Token).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Proactively creates and authenticates up to <paramref name="count"/> idle
    /// connections. Leases are held until every factory call completes, preventing
    /// the warmup workers from repeatedly borrowing the same connection.
    /// </summary>
    public async Task WarmAsync(int count, CancellationToken cancellationToken = default)
    {
        var target = Math.Min(Math.Max(0, count), _maxConnections);
        if (target == 0)
            return;

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, _sweepCts.Token);
        await _warmupGate.WaitAsync(linked.Token).ConfigureAwait(false);
        try
        {
            if (IdleConnections >= target)
                return;

            // Existing active leases cannot become idle until their owners finish.
            // Warmup is best-effort, so reserve only permits available right now and
            // never queue while holding a partial batch.
            var leaseLimit = Math.Min(target, Math.Max(0, AvailableConnections));
            var leases = new ConnectionLock<T>?[leaseLimit];
            try
            {
                var acquisitions = new List<Task>(leaseLimit);
                for (var index = 0; index < leaseLimit; index++)
                {
                    var acquisition = TryStartConnectionLock(linked.Token);
                    if (acquisition is null)
                        break;

                    var capturedIndex = index;
                    acquisitions.Add(StoreLease(acquisition, capturedIndex));
                }

                await Task.WhenAll(acquisitions).ConfigureAwait(false);
            }
            finally
            {
                foreach (var lease in leases)
                    lease?.Dispose();
            }

            async Task StoreLease(Task<ConnectionLock<T>> acquisition, int index)
            {
                leases[index] = await acquisition.ConfigureAwait(false);
            }
        }
        finally
        {
            _warmupGate.Release();
        }
    }

    /* ========================== core helpers ====================================== */

    private readonly record struct Pooled(T Connection, long LastTouchedMillis)
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public bool IsExpired(TimeSpan idle, long nowMillis = 0)
        {
            if (nowMillis == 0) nowMillis = Environment.TickCount64;
            return unchecked(nowMillis - LastTouchedMillis) >= idle.TotalMilliseconds;
        }
    }

    private void Return(T connection)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            DisposeConnection(connection);
            Interlocked.Decrement(ref _live);
            TriggerConnectionPoolChangedEvent();
            return;
        }

        _idleConnections.Push(new Pooled(connection, Environment.TickCount64));
        _gate.Release();
        TriggerConnectionPoolChangedEvent();
    }

    private void Destroy(T connection)
    {
        // When a lock requests replacement, we dispose the connection instead of reusing.
        DisposeConnection(connection);
        Interlocked.Decrement(ref _live);
        if (Volatile.Read(ref _disposed) == 0)
        {
            _gate.Release();
        }

        TriggerConnectionPoolChangedEvent();
    }

    private void TriggerConnectionPoolChangedEvent()
    {
        OnConnectionPoolChanged?.Invoke(this, new ConnectionPoolChangedEventArgs(
            _live,
            _idleConnections.Count,
            _maxConnections
        ));
    }

    /* =================== idle sweeper (background) ================================= */

    private async Task SweepLoop()
    {
        try
        {
            using var timer = new PeriodicTimer(IdleTimeout / 2);
            while (await timer.WaitForNextTickAsync(_sweepCts.Token).ConfigureAwait(false))
                SweepOnce();
        }
        catch (OperationCanceledException)
        {
            /* normal on disposal */
        }
    }

    private void SweepOnce()
    {
        var now = Environment.TickCount64;
        var survivors = new List<Pooled>();
        var isAnyConnectionFreed = false;

        while (_idleConnections.TryPop(out var item))
        {
            if (item.IsExpired(IdleTimeout, now))
            {
                DisposeConnection(item.Connection);
                Interlocked.Decrement(ref _live);
                isAnyConnectionFreed = true;
            }
            else
            {
                survivors.Add(item);
            }
        }

        // Preserve original LIFO order.
        for (var i = survivors.Count - 1; i >= 0; i--)
            _idleConnections.Push(survivors[i]);

        if (isAnyConnectionFreed)
            TriggerConnectionPoolChangedEvent();
    }

    /* ------------------------- dispose helpers ------------------------------------ */

    private static void DisposeConnection(T conn)
    {
        if (conn is IDisposable d)
            d.Dispose();
    }

    /* -------------------------- IAsyncDisposable ---------------------------------- */

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;

        await _sweepCts.CancelAsync().ConfigureAwait(false);

        try
        {
            await _sweeperTask.ConfigureAwait(false); // await clean sweep exit
        }
        catch (OperationCanceledException)
        {
            /* ignore */
        }

        // Drain and dispose cached items.
        while (_idleConnections.TryPop(out var item))
            DisposeConnection(item.Connection);

        _sweepCts.Dispose();
        _gate.Dispose();
    }

    /* ----------------------------- IDisposable ------------------------------------ */

    public void Dispose()
    {
        _ = DisposeAsync().AsTask(); // fire-and-forget synchronous path
    }
}

/// <summary>
/// Disposable wrapper that automatically returns a borrowed connection to the
/// originating <see cref="ConnectionPool{T}"/>.
/// </summary>
public sealed class ConnectionLock<T> : IDisposable
    where T : class
{
    private readonly Action<T> _syncReturn;
    private readonly Action<T> _syncDestroy;
    private T? _connection;
    private int _disposed; // 0 == false, 1 == true
    private int _replace; // 0 == false, 1 == true

    internal ConnectionLock
    (
        T connection,
        Action<T> syncReturn,
        Action<T> syncDestroy,
        bool fromIdlePool = false
    )
    {
        _connection = connection;
        _syncReturn = syncReturn;
        _syncDestroy = syncDestroy;
        WasReused = fromIdlePool;
    }

    /// <summary>
    /// True when this lock wraps a connection reused from the idle pool rather than a
    /// freshly established one. A first-command failure on a reused connection is far
    /// more likely provider-side idle disconnection than a genuine outage, so callers
    /// should replace-and-retry without charging failure budgets.
    /// </summary>
    public bool WasReused { get; }

    public T Connection
        => _connection ?? throw new ObjectDisposedException(nameof(ConnectionLock<T>));

    /// <summary>
    /// Marks the underlying connection to be replaced. When this lock is disposed,
    /// the underlying connection will be destroyed instead of returned to the pool.
    /// </summary>
    public void Replace()
    {
        Volatile.Write(ref _replace, 1);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return; // already done
        var conn = Interlocked.Exchange(ref _connection, null);
        if (conn is not null)
        {
            var replace = Volatile.Read(ref _replace) == 1;
            if (replace)
                _syncDestroy(conn);
            else
                _syncReturn(conn);
        }

        GC.SuppressFinalize(this);
    }
}
