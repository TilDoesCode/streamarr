using Streamarr.Server.Services.Diagnostics;

namespace Streamarr.Server.Tests.Diagnostics;

public sealed class SpeedTestServiceTests
{
    [Fact]
    public void TryAcquire_CapsParallelTransfersPerCallerAndReleasesOnDispose()
    {
        var service = new SpeedTestService();
        var leases = Enumerable.Range(0, SpeedTestService.MaxParallelPerCaller).Select(_ => service.TryAcquire("a")).ToList();

        Assert.All(leases, Assert.NotNull);
        Assert.Null(service.TryAcquire("a"));
        Assert.Equal(SpeedTestService.MaxParallelPerCaller, service.ActiveTransfers);
        using (var other = service.TryAcquire("b"))
            Assert.NotNull(other);

        leases[0]!.Dispose();
        leases[0]!.Dispose();
        Assert.NotNull(service.TryAcquire("a"));
        Assert.Equal(SpeedTestService.MaxParallelPerCaller, service.ActiveTransfers);
    }

    [Fact]
    public void TryAcquire_CapsParallelTransfersGlobally()
    {
        var service = new SpeedTestService();
        var leases = Enumerable.Range(0, SpeedTestService.MaxParallelGlobal).Select(i => service.TryAcquire($"caller-{i}")).ToList();

        Assert.All(leases, Assert.NotNull);
        Assert.Null(service.TryAcquire("late"));
        foreach (var lease in leases)
            lease!.Dispose();
        Assert.Equal(0, service.ActiveTransfers);
        Assert.NotNull(service.TryAcquire("late"));
    }

    [Fact]
    public async Task DrainUpload_CountsBytesAndStopsAboveTheCap()
    {
        var service = new SpeedTestService();

        var result = await service.DrainUploadAsync(new MemoryStream(new byte[300_000]), default);
        Assert.Equal(300_000, result.Bytes);

        await Assert.ThrowsAsync<InvalidDataException>(() => service.DrainUploadAsync(new EndlessStream(), default));
    }

    private sealed class EndlessStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => count;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => ValueTask.FromResult(buffer.Length);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
