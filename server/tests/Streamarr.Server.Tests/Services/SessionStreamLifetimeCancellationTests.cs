using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class SessionStreamLifetimeCancellationTests
{
    [Fact]
    public async Task SupersedeOtherReleases_CancelsReadAlreadyBlockedInRemovedSession()
    {
        var source = new CancellationAwareBlockingStream();
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                MaxSessions = 8,
                MaxConcurrentStreams = 8,
                StreamPacingEnabled = false,
            }),
            NullLogger<SessionManager>.Instance);
        var old = manager.CreateSession(
            "release-a",
            "tmdb-movie-4242",
            MediaFile(source),
            "jellyfin",
            "user-1");
        var selected = manager.CreateSession(
            "release-b",
            "tmdb-movie-4242",
            MediaFile(new MemoryStream([1])),
            "jellyfin",
            "user-1");

        await using var stream = manager.OpenStream(old, paced: false);
        var read = stream.ReadAsync(new byte[1].AsMemory()).AsTask();
        await source.ReadStarted.WaitAsync(TimeSpan.FromSeconds(5));

        var removed = manager.SupersedeOtherReleases(selected, graceSeconds: 10);

        Assert.Equal(old.Token, Assert.Single(removed).Token);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await read.WaitAsync(TimeSpan.FromSeconds(5)));
        await source.CancellationObserved.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(old.IsClosed);
        Assert.False(manager.TryGetSession(old.Token, out _));
        Assert.True(manager.TryGetSession(selected.Token, out _));
    }

    private static ResolvedMediaFile MediaFile(Stream source) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = 1,
        OpenStream = _ => source,
    };

    private sealed class CancellationAwareBlockingStream : Stream
    {
        private readonly TaskCompletionSource<bool> _readStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _cancellationObserved = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private long _position;

        public Task ReadStarted => _readStarted.Task;
        public Task CancellationObserved => _cancellationObserved.Task;
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => 1;
        public override long Position
        {
            get => _position;
            set => _position = value;
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            _readStarted.TrySetResult(true);
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return 0;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                _cancellationObserved.TrySetResult(true);
                throw;
            }
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            Position = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => Position + offset,
                SeekOrigin.End => Length + offset,
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
            return Position;
        }

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override void Flush()
        {
        }

        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();
    }
}
