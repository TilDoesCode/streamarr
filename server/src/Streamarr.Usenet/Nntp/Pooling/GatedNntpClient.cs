// Written for Streamarr. Decorates any INntpClient with a gate that is held for
// the true lifetime of each command — including the background body download of
// BODY/ARTICLE commands, which outlives the method call (the underlying
// NntpConnection signals completion via onConnectionReadyAgain, mirroring how
// the nzbdav connection pool releases its connection locks).

using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Nntp.Pooling;

/// <summary>
/// A hook invoked around every NNTP command issued through a <see cref="GatedNntpClient"/>.
/// Acquire is awaited before the command reaches the inner client; Release fires
/// exactly once when the command no longer occupies a connection.
/// </summary>
public interface INntpGate
{
    ValueTask AcquireAsync(SemaphorePriority priority, CancellationToken cancellationToken);
    void Release();
}

/// <summary>
/// Caps concurrent NNTP commands with a <see cref="PrioritizedSemaphore"/> —
/// used as the global connection budget shared across all streaming sessions
/// (BRIEF.md §6.1 module 6). BODY/ARTICLE waiters outrank STAT/HEAD/DATE so
/// health checks cannot starve active playback.
/// </summary>
public sealed class SemaphoreNntpGate(PrioritizedSemaphore semaphore) : INntpGate, IDisposable
{
    public SemaphoreNntpGate(int budget)
        : this(new PrioritizedSemaphore(budget, budget, new SemaphorePriorityOdds { HighPriorityOdds = 90 }))
    {
    }

    public async ValueTask AcquireAsync(SemaphorePriority priority, CancellationToken cancellationToken)
        => await semaphore.WaitAsync(priority, cancellationToken).ConfigureAwait(false);

    public void Release() => semaphore.Release();

    public void Dispose() => semaphore.Dispose();
}

/// <summary>
/// Counts NNTP usage without limiting it — the per-session usage meter
/// surfaced by <c>GET /api/v1/sessions</c>.
/// </summary>
public sealed class CountingNntpGate : INntpGate
{
    private int _inFlight;
    private long _totalCommands;

    /// <summary>Commands currently occupying an NNTP connection.</summary>
    public int InFlight => Volatile.Read(ref _inFlight);

    /// <summary>Total NNTP commands issued through this gate.</summary>
    public long TotalCommands => Interlocked.Read(ref _totalCommands);

    public ValueTask AcquireAsync(SemaphorePriority priority, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _inFlight);
        Interlocked.Increment(ref _totalCommands);
        return ValueTask.CompletedTask;
    }

    public void Release() => Interlocked.Decrement(ref _inFlight);
}

/// <summary>
/// Pass-through NNTP client that routes every command through an <see cref="INntpGate"/>.
/// STAT/HEAD/DATE hold the gate for the duration of the call; BODY/ARTICLE hold it
/// until the article body has fully left the wire (signalled by the inner client's
/// onConnectionReadyAgain callback), matching actual connection occupancy.
/// </summary>
public class GatedNntpClient(INntpClient inner, INntpGate gate, bool disposeInner = false)
    : NntpClientBase
{
    public INntpGate Gate => gate;

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
        => throw new NotSupportedException("Please connect within the connectionFactory");

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken)
        => throw new NotSupportedException("Please authenticate within the connectionFactory");

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken ct)
        => RunGated(SemaphorePriority.Low, () => inner.StatAsync(segmentId, ct), ct);

    public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken ct)
        => RunGated(SemaphorePriority.Low, () => inner.HeadAsync(segmentId, ct), ct);

    public override Task<NntpDateResponse> DateAsync(CancellationToken ct)
        => RunGated(SemaphorePriority.Low, () => inner.DateAsync(ct), ct);

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, CancellationToken ct)
        => DecodedBodyAsync(segmentId, onConnectionReadyAgain: null, ct);

    public override async Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken ct
    )
    {
        await gate.AcquireAsync(SemaphorePriority.High, ct).ConfigureAwait(false);
        var released = 0;
        try
        {
            return await inner.DecodedBodyAsync(segmentId, Callback, ct).ConfigureAwait(false);
        }
        catch
        {
            ReleaseOnce();
            throw;
        }

        void Callback(ArticleBodyResult result)
        {
            ReleaseOnce();
            onConnectionReadyAgain?.Invoke(result);
        }

        void ReleaseOnce()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
                gate.Release();
        }
    }

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, CancellationToken ct)
        => DecodedArticleAsync(segmentId, onConnectionReadyAgain: null, ct);

    public override async Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken ct
    )
    {
        await gate.AcquireAsync(SemaphorePriority.High, ct).ConfigureAwait(false);
        var released = 0;
        try
        {
            return await inner.DecodedArticleAsync(segmentId, Callback, ct).ConfigureAwait(false);
        }
        catch
        {
            ReleaseOnce();
            throw;
        }

        void Callback(ArticleBodyResult result)
        {
            ReleaseOnce();
            onConnectionReadyAgain?.Invoke(result);
        }

        void ReleaseOnce()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
                gate.Release();
        }
    }

    private async Task<T> RunGated<T>(SemaphorePriority priority, Func<Task<T>> command, CancellationToken ct)
        where T : NntpResponse
    {
        await gate.AcquireAsync(priority, ct).ConfigureAwait(false);
        try
        {
            return await command().ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    public override void Dispose()
    {
        if (disposeInner)
            inner.Dispose();
        if (gate is IDisposable disposableGate)
            disposableGate.Dispose();
        GC.SuppressFinalize(this);
    }
}
