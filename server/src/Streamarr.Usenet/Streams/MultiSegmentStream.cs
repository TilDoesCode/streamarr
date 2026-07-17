// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Streams/{MultiSegmentStream,UnbufferedMultiSegmentStream}.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr: the buffered
// variant uses pooled DecodedBodyAsync read-ahead instead of nzbdav's
// exclusive-connection mechanism; pooled connections are still released as soon
// as each article body has fully arrived (onConnectionReadyAgain).

using System.Threading.Channels;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Usenet.Streams;

/// <summary>
/// Concatenates the yEnc-decoded bodies of consecutive segments into one
/// forward-only stream. With <c>articleBufferSize &gt; 0</c>, up to that many
/// segment downloads run ahead of the reader.
/// </summary>
public class MultiSegmentStream : FastReadOnlyNonSeekableStream
{
    private readonly Memory<string> _segmentIds;
    private readonly INntpClient _usenetClient;
    private readonly SegmentCache? _segmentCache;
    private readonly int _retryCount;
    private readonly Action<string>? _onSegmentRequested;
    private readonly Channel<Task<Stream>> _streamTasks;
    private readonly CancellationTokenSource _cts;
    private Stream? _stream;
    private bool _disposed;

    public static Stream Create
    (
        Memory<string> segmentIds,
        INntpClient usenetClient,
        int articleBufferSize,
        CancellationToken cancellationToken,
        SegmentCache? segmentCache = null,
        int retryCount = 2,
        Action<string>? onSegmentRequested = null
    )
    {
        return articleBufferSize == 0
            ? new UnbufferedMultiSegmentStream(segmentIds, usenetClient, onSegmentRequested)
            : new MultiSegmentStream(
                segmentIds, usenetClient, articleBufferSize, cancellationToken, segmentCache, retryCount, onSegmentRequested);
    }

    private MultiSegmentStream
    (
        Memory<string> segmentIds,
        INntpClient usenetClient,
        int articleBufferSize,
        CancellationToken cancellationToken,
        SegmentCache? segmentCache,
        int retryCount,
        Action<string>? onSegmentRequested
    )
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _segmentCache = segmentCache;
        _retryCount = retryCount is >= 0 and <= 10
            ? retryCount
            : throw new ArgumentOutOfRangeException(nameof(retryCount));
        _onSegmentRequested = onSegmentRequested;
        _streamTasks = Channel.CreateBounded<Task<Stream>>(articleBufferSize);
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _ = DownloadSegments(_cts.Token);
    }

    private async Task DownloadSegments(CancellationToken cancellationToken)
    {
        try
        {
            for (var i = 0; i < _segmentIds.Length; i++)
            {
                var segmentId = _segmentIds.Span[i];

                await _streamTasks.Writer.WaitToWriteAsync(cancellationToken).ConfigureAwait(false);

                // Queue in NZB order, but start every task in the bounded window now.
                // The reader awaits the tasks in channel order, so delivery remains ordered.
                var streamTask = DownloadSegment(segmentId, cancellationToken);
                if (!_streamTasks.Writer.TryWrite(streamTask))
                {
                    // if we never get a chance to write the stream to the writer
                    // then make sure the stream gets disposed.
                    _ = Task.Run(async () => await (await streamTask.ConfigureAwait(false))
                        .DisposeAsync().ConfigureAwait(false), CancellationToken.None);
                    break;
                }
            }
        }
        catch
        {
            // errors surface through the queued stream tasks on read
        }
        finally
        {
            _streamTasks.Writer.TryComplete();
        }
    }

    private async Task<Stream> DownloadSegment
    (
        string segmentId,
        CancellationToken cancellationToken
    )
    {
        _onSegmentRequested?.Invoke(SegmentId.Normalize(segmentId));
        var bytes = _segmentCache is null
            ? await DownloadSegmentBytes(segmentId, cancellationToken).ConfigureAwait(false)
            : await _segmentCache.GetOrAddAsync(
                segmentId,
                ct => DownloadSegmentBytes(segmentId, ct),
                cancellationToken).ConfigureAwait(false);
        return new MemoryStream(bytes, writable: false);
    }

    private async Task<byte[]> DownloadSegmentBytes(string segmentId, CancellationToken cancellationToken)
    {
        Exception? lastFailure = null;
        for (var attempt = 0; attempt <= _retryCount; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var bodyResponse = await _usenetClient
                    .DecodedBodyAsync(segmentId, cancellationToken)
                    .ConfigureAwait(false);
                await using var body = bodyResponse.Stream;
                var headers = await body.GetYencHeadersAsync(cancellationToken).ConfigureAwait(false);
                var capacity = headers?.PartSize is > 0 and <= int.MaxValue
                    ? checked((int)headers.PartSize)
                    : 0;
                using var output = capacity > 0 ? new MemoryStream(capacity) : new MemoryStream();
                await body.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
                if (output.TryGetBuffer(out var buffer) && output.Length == buffer.Count)
                    return buffer.Array!;
                return output.ToArray();
            }
            catch (Exception e) when (e is not OperationCanceledException and not UsenetArticleNotFoundException)
            {
                lastFailure = e;
            }
        }

        throw new IOException(
            $"NNTP article <{SegmentId.Normalize(segmentId)}> failed after {_retryCount + 1} attempts.",
            lastFailure);
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (buffer.IsEmpty) return 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            // if the stream is null, get the next stream.
            if (_stream == null)
            {
                if (!await _streamTasks.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false)) return 0;
                if (!_streamTasks.Reader.TryRead(out var streamTask)) return 0;
                _stream = await streamTask.ConfigureAwait(false);
            }

            // read from the stream
            var read = await _stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read > 0) return read;

            // if the stream ended, continue to the next stream.
            await _stream.DisposeAsync().ConfigureAwait(false);
            _stream = null;
        }

        return 0;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        if (!disposing) return;
        _disposed = true;
        _cts.Cancel();
        _cts.Dispose();
        _stream?.Dispose();
        _streamTasks.Writer.TryComplete();

        // ensure that streams that were never read from the channel get disposed
        while (_streamTasks.Reader.TryRead(out var streamTask))
            _ = Task.Run(async () =>
            {
                try
                {
                    await (await streamTask.ConfigureAwait(false)).DisposeAsync().ConfigureAwait(false);
                }
                catch
                {
                    // stream task may have failed; nothing to dispose
                }
            }, CancellationToken.None);

        base.Dispose(disposing);
    }
}

/// <summary>
/// Concatenates the yEnc-decoded bodies of consecutive segments with no
/// read-ahead: each segment is downloaded on demand.
/// </summary>
public class UnbufferedMultiSegmentStream : FastReadOnlyNonSeekableStream
{
    private readonly Memory<string> _segmentIds;
    private readonly INntpClient _usenetClient;
    private Stream? _stream;
    private int _currentIndex;
    private bool _disposed;
    private readonly Action<string>? _onSegmentRequested;

    public UnbufferedMultiSegmentStream(
        Memory<string> segmentIds,
        INntpClient usenetClient,
        Action<string>? onSegmentRequested = null)
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _onSegmentRequested = onSegmentRequested;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (buffer.IsEmpty) return 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            // if the stream is null, get the next stream.
            if (_stream == null)
            {
                if (_currentIndex >= _segmentIds.Length) return 0;
                _onSegmentRequested?.Invoke(SegmentId.Normalize(_segmentIds.Span[_currentIndex]));
                var body = await _usenetClient
                    .DecodedBodyAsync(_segmentIds.Span[_currentIndex++], cancellationToken)
                    .ConfigureAwait(false);
                _stream = body.Stream;
            }

            // read from the stream
            var read = await _stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read > 0) return read;

            // if the stream ended, continue to the next stream.
            await _stream.DisposeAsync().ConfigureAwait(false);
            _stream = null;
        }

        return 0;
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        if (!disposing) return;
        _disposed = true;
        _stream?.Dispose();
        base.Dispose(disposing);
    }
}
