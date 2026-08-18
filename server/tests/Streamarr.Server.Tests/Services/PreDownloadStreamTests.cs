using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class PreDownloadCacheFileTests
{
    private static readonly string Token = new('a', 48);

    [Fact]
    public async Task DownloadAsync_PublishesCompleteFileOnlyAfterTheDeclaredLengthArrives()
    {
        using var temp = new TempPreDownloadWorkspace();
        var payload = Enumerable.Range(0, 257).Select(i => (byte)i).ToArray();
        await using var source = new PausedAfterPrefixStream(payload, prefixLength: 37);
        using var cache = new PreDownloadCacheFile(temp.Workspace, Token, payload.Length);
        var paths = temp.Workspace.Paths(Token);

        var download = cache.DownloadAsync(source, onProgress: null, CancellationToken.None);
        await source.WaitUntilPausedAsync();

        Assert.False(cache.IsComplete);
        Assert.Equal(37, cache.DownloadedBytes);
        Assert.True(File.Exists(paths.Partial));
        Assert.False(File.Exists(paths.Complete));
        Assert.Equal(payload[..37], await File.ReadAllBytesAsync(paths.Partial));

        source.Resume();
        await download;

        Assert.True(cache.IsComplete);
        Assert.Equal(payload.Length, cache.DownloadedBytes);
        Assert.False(File.Exists(paths.Partial));
        Assert.True(File.Exists(paths.Complete));
        Assert.Equal(payload, await File.ReadAllBytesAsync(paths.Complete));
    }

    [Fact]
    public async Task DownloadAsync_WhenSourceEndsEarly_RemovesEveryPartialArtifact()
    {
        using var temp = new TempPreDownloadWorkspace();
        var payload = Enumerable.Range(0, 97).Select(i => (byte)i).ToArray();
        await using var source = new MemoryStream(payload);
        using var cache = new PreDownloadCacheFile(temp.Workspace, Token, payload.Length + 1);
        var paths = temp.Workspace.Paths(Token);

        await Assert.ThrowsAsync<EndOfStreamException>(() =>
            cache.DownloadAsync(source, onProgress: null, CancellationToken.None));

        Assert.False(cache.IsComplete);
        Assert.False(File.Exists(paths.Partial));
        Assert.False(File.Exists(paths.Complete));
    }

    [Fact]
    public async Task DownloadAsync_WhenCancelled_RemovesEveryPartialArtifact()
    {
        using var temp = new TempPreDownloadWorkspace();
        var payload = Enumerable.Range(0, 173).Select(i => (byte)i).ToArray();
        await using var source = new PausedAfterPrefixStream(payload, prefixLength: 41);
        using var cache = new PreDownloadCacheFile(temp.Workspace, Token, payload.Length);
        var paths = temp.Workspace.Paths(Token);
        using var cancellation = new CancellationTokenSource();

        var download = cache.DownloadAsync(source, onProgress: null, cancellation.Token);
        await source.WaitUntilPausedAsync();
        Assert.True(File.Exists(paths.Partial));

        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => download);

        Assert.False(cache.IsComplete);
        Assert.False(File.Exists(paths.Partial));
        Assert.False(File.Exists(paths.Complete));
    }
}

public sealed class PreDownloadAwareStreamTests
{
    private static readonly string Token = new('b', 48);

    [Fact]
    public async Task ReadAsync_UsesReadableLocalPrefixThenContinuesAtTheExactRemoteByte()
    {
        using var temp = new TempPreDownloadWorkspace();
        var payload = Enumerable.Range(0, 193).Select(i => (byte)(i * 17)).ToArray();
        const int prefixLength = 53;
        await using var source = new PausedAfterPrefixStream(payload, prefixLength);
        using var cache = new PreDownloadCacheFile(temp.Workspace, Token, payload.Length);
        using var cancellation = new CancellationTokenSource();
        var download = cache.DownloadAsync(source, onProgress: null, cancellation.Token);
        await source.WaitUntilPausedAsync();

        var remote = new TrackingMemoryStream(payload);
        await using var stream = new PreDownloadAwareStream(remote, () => cache);
        var result = new byte[payload.Length];

        try
        {
            var firstRead = await stream.ReadAsync(result);
            Assert.Equal(prefixLength, firstRead);
            Assert.Equal(payload[..prefixLength], result[..prefixLength]);
            Assert.Empty(remote.ReadPositions);

            var offset = firstRead;
            while (offset < result.Length)
            {
                var read = await stream.ReadAsync(result.AsMemory(offset));
                Assert.NotEqual(0, read);
                offset += read;
            }

            Assert.Equal(payload, result);
            Assert.NotEmpty(remote.ReadPositions);
            Assert.Equal(prefixLength, remote.ReadPositions[0]);
        }
        finally
        {
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => download);
        }
    }

    [Fact]
    public async Task ReadAsync_AfterAtomicCompletion_ServesTheWholeFileWithoutRemoteReads()
    {
        using var temp = new TempPreDownloadWorkspace();
        var payload = Enumerable.Range(0, 311).Select(i => (byte)(i * 29)).ToArray();
        using var cache = new PreDownloadCacheFile(temp.Workspace, Token, payload.Length);
        await using (var source = new MemoryStream(payload))
            await cache.DownloadAsync(source, onProgress: null, CancellationToken.None);

        var remote = new TrackingMemoryStream(payload);
        await using var stream = new PreDownloadAwareStream(remote, () => cache);
        using var result = new MemoryStream();

        await stream.CopyToAsync(result);

        Assert.Equal(payload, result.ToArray());
        Assert.Empty(remote.ReadPositions);
    }
}

internal sealed class TempPreDownloadWorkspace : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("streamarr-pre-download-stream-").FullName;

    public TempPreDownloadWorkspace()
    {
        var options = new StreamarrOptions
        {
            PreDownload = new PreDownloadOptions
            {
                CachePath = Path.Combine(_root, "cache"),
                MinimumFreeDiskBytes = 0,
            },
        };
        Workspace = new PreDownloadWorkspace(
            Microsoft.Extensions.Options.Options.Create(options),
            new TestHostEnvironment(_root),
            NullLogger<PreDownloadWorkspace>.Instance);
    }

    public PreDownloadWorkspace Workspace { get; }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private sealed class TestHostEnvironment(string root) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Streamarr.Server.Tests";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

internal sealed class PausedAfterPrefixStream(byte[] payload, int prefixLength) : Stream
{
    private readonly TaskCompletionSource _paused = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _resume = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _phase;

    public Task WaitUntilPausedAsync() => _paused.Task.WaitAsync(TimeSpan.FromSeconds(5));

    public void Resume() => _resume.TrySetResult();

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        if (_phase == 0)
        {
            var count = Math.Min(prefixLength, buffer.Length);
            payload.AsMemory(0, count).CopyTo(buffer);
            _phase = 1;
            return count;
        }

        if (_phase == 1)
        {
            _paused.TrySetResult();
            await _resume.Task.WaitAsync(cancellationToken);
            var count = Math.Min(payload.Length - prefixLength, buffer.Length);
            payload.AsMemory(prefixLength, count).CopyTo(buffer);
            _phase = 2;
            return count;
        }

        return 0;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => payload.Length;
    public override long Position
    {
        get => _phase == 0 ? 0 : _phase == 1 ? prefixLength : payload.Length;
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override void Flush() => throw new NotSupportedException();
}

internal sealed class TrackingMemoryStream(byte[] payload) : MemoryStream(payload)
{
    public List<long> ReadPositions { get; } = [];

    public override int Read(byte[] buffer, int offset, int count)
    {
        ReadPositions.Add(Position);
        return base.Read(buffer, offset, count);
    }

    public override int Read(Span<byte> buffer)
    {
        ReadPositions.Add(Position);
        return base.Read(buffer);
    }

    public override ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        ReadPositions.Add(Position);
        return base.ReadAsync(buffer, cancellationToken);
    }
}
