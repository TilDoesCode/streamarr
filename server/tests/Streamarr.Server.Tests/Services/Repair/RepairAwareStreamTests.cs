using Streamarr.Server.Services;
using Streamarr.Server.Services.Repair;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Tests.Services.Repair;

public class RepairAwareStreamTests
{
    private static readonly RepairStreamContext Context = new("rel-1", "work-1", "Title");

    /// <summary>A stream that serves a prefix, then throws once at the hole offset.</summary>
    private sealed class HoleStream(byte[] data, long holeAt, Exception failure) : MemoryStream(data)
    {
        private bool _failed;

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            if (!_failed && Position >= holeAt)
            {
                _failed = true;
                return ValueTask.FromException<int>(failure);
            }
            var take = (int)Math.Min(buffer.Length, Math.Min(holeAt - Position, Length - Position));
            if (take <= 0 && Position < Length)
                return ValueTask.FromException<int>(failure);
            return base.ReadAsync(buffer[..Math.Max(0, take)], ct);
        }
    }

    private sealed class FakeGateway : IRepairStreamGateway
    {
        public bool Enabled => true;
        public Func<Task<Stream>>? LocalFactory { get; set; }
        public Exception? AdmissionFailure { get; set; }
        public Exception? TicketFailure { get; set; }
        public bool Decline { get; set; }
        public int HoleWaits { get; private set; }
        public long? ReportedPosition { get; private set; }

        public bool AllowsPlaybackWhileDead(string releaseId) => true;

        public Task<Stream?> TryOpenLocalMediaAsync(string releaseId, CancellationToken ct)
            => Task.FromResult<Stream?>(null);

        public Task<IRepairHoleTicket?> TryBeginHoleWaitAsync(
            RepairStreamContext context, long position, Exception failure, CancellationToken ct)
        {
            HoleWaits++;
            ReportedPosition = position;
            if (AdmissionFailure is not null)
                throw AdmissionFailure;
            if (Decline)
                return Task.FromResult<IRepairHoleTicket?>(null);
            return Task.FromResult<IRepairHoleTicket?>(new Ticket(this));
        }

        private sealed class Ticket(FakeGateway gateway) : IRepairHoleTicket
        {
            public async Task<Stream> WaitForLocalStreamAsync(CancellationToken readerCt)
            {
                readerCt.ThrowIfCancellationRequested();
                if (gateway.TicketFailure is not null)
                    throw gateway.TicketFailure;
                return await gateway.LocalFactory!();
            }
        }
    }

    private sealed class CountingDisposeStream(byte[] data) : MemoryStream(data)
    {
        public int DisposeCount { get; private set; }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                DisposeCount++;
            base.Dispose(disposing);
        }
    }

    private static byte[] Payload(int size = 100_000)
    {
        var data = new byte[size];
        new Random(7).NextBytes(data);
        return data;
    }

    [Fact]
    public async Task HealthyStream_PassesThroughUntouched()
    {
        var data = Payload();
        var gateway = new FakeGateway();
        await using var stream = new RepairAwareStream(new MemoryStream(data), gateway, Context);

        var result = new MemoryStream();
        await stream.CopyToAsync(result);

        Assert.Equal(data, result.ToArray());
        Assert.Equal(0, gateway.HoleWaits);
        Assert.False(stream.IsServingLocally);
    }

    [Fact]
    public async Task ArticleLossMidStream_SwapsToLocalAtTheExactOffset_AndOutputIsByteIdentical()
    {
        var data = Payload();
        var gateway = new FakeGateway
        {
            LocalFactory = () => Task.FromResult<Stream>(new MemoryStream(Payload())),
        };
        await using var stream = new RepairAwareStream(
            new HoleStream(data, 40_000, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);

        var result = new MemoryStream();
        await stream.CopyToAsync(result);

        Assert.Equal(data, result.ToArray());
        Assert.Equal(1, gateway.HoleWaits);
        Assert.Equal(40_000, gateway.ReportedPosition);
        Assert.True(stream.IsServingLocally);
    }

    [Fact]
    public async Task CrcFailureWrappedInIoException_IsClassifiedRepairable()
    {
        var data = Payload();
        var gateway = new FakeGateway
        {
            LocalFactory = () => Task.FromResult<Stream>(new MemoryStream(Payload())),
        };
        var failure = new IOException("failed after retries", new YencCrcMismatchException("crc"));
        await using var stream = new RepairAwareStream(new HoleStream(data, 8_192, failure), gateway, Context);

        var result = new MemoryStream();
        await stream.CopyToAsync(result);

        Assert.Equal(data, result.ToArray());
        Assert.True(stream.IsServingLocally);
    }

    [Fact]
    public async Task UnclassifiedFailures_AreNeverIntercepted()
    {
        var gateway = new FakeGateway();
        await using var stream = new RepairAwareStream(
            new HoleStream(Payload(), 4_096, new IOException("plain transport failure")),
            gateway,
            Context);

        await Assert.ThrowsAsync<IOException>(async () => await stream.CopyToAsync(new MemoryStream()));
        Assert.Equal(0, gateway.HoleWaits);
    }

    [Fact]
    public async Task GatewayDecline_RethrowsTheOriginalException()
    {
        var gateway = new FakeGateway { Decline = true };
        await using var stream = new RepairAwareStream(
            new HoleStream(Payload(), 4_096, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);

        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(
            async () => await stream.CopyToAsync(new MemoryStream()));
    }

    [Fact]
    public async Task AdmissionAnalysisFailure_RethrowsTheOriginalHoleException()
    {
        var gateway = new FakeGateway
        {
            AdmissionFailure = new ReleaseNotFoundException("rel-1"),
        };
        await using var stream = new RepairAwareStream(
            new HoleStream(Payload(), 4_096, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);

        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(
            async () => await stream.CopyToAsync(new MemoryStream()));
        Assert.Equal(1, gateway.HoleWaits);
    }

    [Fact]
    public async Task TerminalRepairFailure_SurfacesTheOriginalExceptionForLegacyHandling()
    {
        var gateway = new FakeGateway
        {
            TicketFailure = new RepairFailedException(RepairDisposition.InsufficientParity, "not enough parity"),
        };
        await using var stream = new RepairAwareStream(
            new HoleStream(Payload(), 4_096, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);

        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(
            async () => await stream.CopyToAsync(new MemoryStream()));
        Assert.Equal(1, gateway.HoleWaits);
    }

    [Fact]
    public async Task ReaderCancellation_PropagatesWithoutMaskingAsRepairFailure()
    {
        var gateway = new FakeGateway();
        await using var stream = new RepairAwareStream(
            new HoleStream(Payload(), 0, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            // The first read throws the hole failure; with a cancelled token the wrapper
            // must not classify (no repair hijack of a dying request).
            var buffer = new byte[1024];
            await stream.ReadAsync(buffer, cts.Token);
        });
        Assert.Equal(0, gateway.HoleWaits);
    }

    [Fact]
    public async Task SeekingWorksAcrossTheLocalSwap()
    {
        var data = Payload();
        var gateway = new FakeGateway
        {
            LocalFactory = () => Task.FromResult<Stream>(new MemoryStream(Payload())),
        };
        await using var stream = new RepairAwareStream(
            new HoleStream(data, 50_000, new UsenetArticleNotFoundException("seg@test")),
            gateway,
            Context);

        // Trigger the swap by reading through the hole.
        var swallow = new byte[data.Length];
        var read = 0;
        while (read < data.Length)
        {
            var n = await stream.ReadAsync(swallow.AsMemory(read));
            if (n == 0)
                break;
            read += n;
        }
        Assert.True(stream.IsServingLocally);

        stream.Seek(12_345, SeekOrigin.Begin);
        var chunk = new byte[1_000];
        await stream.ReadExactlyAsync(chunk);
        Assert.Equal(data[12_345..13_345], chunk);
        Assert.Equal(data.Length, stream.Length);
    }

    [Fact]
    public async Task DisposeAsync_IsIdempotent_AndDisposesInnerExactlyOnce()
    {
        var inner = new CountingDisposeStream(Payload());
        var stream = new RepairAwareStream(inner, new FakeGateway(), Context);

        await stream.DisposeAsync();
        await stream.DisposeAsync();
        stream.Dispose();

        Assert.Equal(1, inner.DisposeCount);
    }
}
