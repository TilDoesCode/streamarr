// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Streams/CombinedStream.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root.

namespace Streamarr.Usenet.Streams;

public class CombinedStream(IEnumerable<Task<Stream>> streams) : FastReadOnlyNonSeekableStream
{
    private readonly IEnumerator<Task<Stream>> _streams = streams.GetEnumerator();
    private Stream? _currentStream;
    private long _position;
    private bool _isDisposed;

    public override long Position
    {
        get => _position;
        set => throw new NotSupportedException();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (buffer.Length == 0) return 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            // If we haven't read the first stream, read it.
            if (_currentStream == null)
            {
                if (!_streams.MoveNext()) return 0;
                _currentStream = await _streams.Current.ConfigureAwait(false);
            }

            // read from our current stream
            var readCount = await _currentStream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            _position += readCount;
            if (readCount > 0) return readCount;

            // If we couldn't read anything from our current stream,
            // it's time to advance to the next stream.
            await _currentStream.DisposeAsync().ConfigureAwait(false);
            if (!_streams.MoveNext())
            {
                _currentStream = null;
                return 0;
            }

            _currentStream = await _streams.Current.ConfigureAwait(false);
        }

        return 0;
    }

    public override void Flush()
    {
        _currentStream?.Flush();
    }

    public override Task FlushAsync(CancellationToken cancellationToken)
    {
        return _currentStream?.FlushAsync(cancellationToken) ?? Task.CompletedTask;
    }

    protected override void Dispose(bool disposing)
    {
        if (_isDisposed) return;
        if (!disposing) return;
        _streams.Dispose();
        _currentStream?.Dispose();
        _isDisposed = true;
    }

    public override async ValueTask DisposeAsync()
    {
        if (_isDisposed) return;
        if (_currentStream != null) await _currentStream.DisposeAsync().ConfigureAwait(false);
        _streams.Dispose();
        _isDisposed = true;
        GC.SuppressFinalize(this);
    }
}
