using System.Runtime.ExceptionServices;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Services.Repair;

/// <summary>Identifies the release a stream belongs to (no secrets).</summary>
public sealed record RepairStreamContext(string ReleaseId, string? WorkId, string? ReleaseTitle);

/// <summary>A single reader's wait on a shared repair job.</summary>
public interface IRepairHoleTicket
{
    /// <summary>
    /// Waits for the repaired local projection. Throws <see cref="OperationCanceledException"/>
    /// when the reader goes away, or a terminal repair failure — never returns unverified data.
    /// </summary>
    Task<Stream> WaitForLocalStreamAsync(CancellationToken readerCt);
}

/// <summary>What the streaming layer needs from the repair subsystem.</summary>
public interface IRepairStreamGateway
{
    bool Enabled { get; }

    /// <summary>True while sessions of an origin-dead release must stay alive (artifact/job).</summary>
    bool AllowsPlaybackWhileDead(string releaseId);

    /// <summary>A verified local artifact for the release, opened as a media stream — or null.</summary>
    Task<Stream?> TryOpenLocalMediaAsync(string releaseId, CancellationToken ct);

    /// <summary>
    /// Called by a stream that hit a classified, provider-exhausted damage error. Returns
    /// null when repair does not engage (caller rethrows and the legacy dead/invalidations run).
    /// </summary>
    Task<IRepairHoleTicket?> TryBeginHoleWaitAsync(
        RepairStreamContext context,
        long position,
        Exception failure,
        CancellationToken ct);
}

/// <summary>
/// Wraps a remote media projection. Healthy reads pass through untouched (zero repair
/// I/O). When a read fails with a classified damage error after full provider failover,
/// the stream remembers its logical offset, waits (cancellation-safe, bounded) for the
/// shared repair job, then swaps atomically to the verified local projection at the same
/// offset and repeats the read — same URL, length, range semantics and timeline. When
/// repair does not engage, the original exception continues to the legacy handling.
/// </summary>
public sealed class RepairAwareStream(
    Stream inner,
    IRepairStreamGateway gateway,
    RepairStreamContext context) : Stream
{
    private Stream _inner = inner;
    private bool _local;
    private int _disposeState;

    public bool IsServingLocally => _local;

    public static bool IsRepairableFailure(Exception e) => e switch
    {
        UsenetArticleNotFoundException => true,
        YencCrcMismatchException => true,
        IOException { InnerException: UsenetArticleNotFoundException or YencCrcMismatchException } => true,
        _ => false,
    };

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            long position;
            ExceptionDispatchInfo failure;
            try
            {
                return await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception e) when (!_local && IsRepairableFailure(e) && !cancellationToken.IsCancellationRequested)
            {
                position = _inner.Position;
                failure = ExceptionDispatchInfo.Capture(e);
            }

            IRepairHoleTicket? ticket;
            try
            {
                ticket = await gateway.TryBeginHoleWaitAsync(
                    context,
                    position,
                    failure.SourceException,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Admission is best-effort. If NZB/release analysis itself fails, retain
                // the original classified hole so legacy invalidation/failover sees the
                // failure that actually interrupted playback.
                failure.Throw();
                throw; // unreachable
            }
            if (ticket is null)
                failure.Throw();

            Stream local;
            try
            {
                local = await ticket!.WaitForLocalStreamAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // The reader went away; only this waiter dies, the shared job lives on.
                throw;
            }
            catch
            {
                // Terminal repair failure/timeout: surface the ORIGINAL error so the
                // pre-existing dead/invalidation/fallback behavior applies unchanged.
                failure.Throw();
                throw; // unreachable
            }

            try
            {
                local.Position = position;
            }
            catch
            {
                await local.DisposeAsync().ConfigureAwait(false);
                throw;
            }
            try
            {
                await _inner.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception e) when (IsRepairableFailure(e))
            {
                // A deferred integrity failure from the damaged remote stream is already repaired.
            }
            catch
            {
                try
                {
                    await local.DisposeAsync().ConfigureAwait(false);
                }
                catch
                {
                    // Preserve the remote cleanup failure that prevented the handoff.
                }
                throw;
            }
            _inner = local;
            _local = true;
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
        => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override bool CanRead => true;
    public override bool CanSeek => _inner.CanSeek;
    public override bool CanWrite => false;
    public override long Length => _inner.Length;

    public override long Position
    {
        get => _inner.Position;
        set => _inner.Position = value;
    }

    public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing && Interlocked.Exchange(ref _disposeState, 1) == 0)
            _inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeState, 1) != 0)
            return;

        try
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            base.Dispose(true);
            GC.SuppressFinalize(this);
        }
    }
}
