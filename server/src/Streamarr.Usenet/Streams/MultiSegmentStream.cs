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
using Streamarr.Usenet.Yenc;

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
    private readonly SemaphoreSlim _queueAdvanced = new(0);
    private readonly CancellationTokenSource _cts;
    private readonly int _steadyReadAhead;
    private readonly int _startupReadAhead;
    private readonly int _startupReadAheadSegments;
    private readonly bool _onDemand;
    private int _queuedTasks;
    private int _nextSegmentIndex;
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
        Action<string>? onSegmentRequested = null,
        int startupArticleBufferSize = 0,
        int startupReadAheadSegments = 0,
        Stream? openedFirstSegment = null,
        bool progressiveFirstSegment = false,
        bool disableReadAhead = false
    )
    {
        return articleBufferSize == 0
            ? new UnbufferedMultiSegmentStream(
                segmentIds,
                usenetClient,
                onSegmentRequested,
                openedFirstSegment,
                segmentCache,
                progressiveFirstSegment)
            : new MultiSegmentStream(
                segmentIds,
                usenetClient,
                articleBufferSize,
                startupArticleBufferSize,
                startupReadAheadSegments,
                cancellationToken,
                segmentCache,
                retryCount,
                onSegmentRequested,
                openedFirstSegment,
                progressiveFirstSegment,
                disableReadAhead);
    }

    private MultiSegmentStream
    (
        Memory<string> segmentIds,
        INntpClient usenetClient,
        int articleBufferSize,
        int startupArticleBufferSize,
        int startupReadAheadSegments,
        CancellationToken cancellationToken,
        SegmentCache? segmentCache,
        int retryCount,
        Action<string>? onSegmentRequested,
        Stream? openedFirstSegment,
        bool progressiveFirstSegment,
        bool disableReadAhead
    )
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _segmentCache = segmentCache;
        _retryCount = retryCount is >= 0 and <= 10
            ? retryCount
            : throw new ArgumentOutOfRangeException(nameof(retryCount));
        _onSegmentRequested = onSegmentRequested;
        _steadyReadAhead = articleBufferSize;
        var startupWindow = startupArticleBufferSize > 0
            ? Math.Max(articleBufferSize, startupArticleBufferSize)
            : articleBufferSize;
        _startupReadAhead = startupWindow;
        _startupReadAheadSegments = startupReadAheadSegments > 0
            ? startupReadAheadSegments
            : startupWindow;
        _streamTasks = Channel.CreateBounded<Task<Stream>>(startupWindow);
        _cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _openedFirstSegment = openedFirstSegment;
        _progressiveFirstSegment = progressiveFirstSegment;
        _onDemand = disableReadAhead;
        if (!_onDemand)
            _ = DownloadSegments(_cts.Token);
    }

    private Stream? _openedFirstSegment;
    private readonly bool _progressiveFirstSegment;

    private async Task DownloadSegments(CancellationToken cancellationToken)
    {
        try
        {
            for (var i = 0; i < _segmentIds.Length; i++)
            {
                var segmentId = _segmentIds.Span[i];
                var targetDepth = i < _startupReadAheadSegments
                    ? _startupReadAhead
                    : _steadyReadAhead;

                while (Volatile.Read(ref _queuedTasks) >= targetDepth)
                    await _queueAdvanced.WaitAsync(cancellationToken).ConfigureAwait(false);

                await _streamTasks.Writer.WaitToWriteAsync(cancellationToken).ConfigureAwait(false);

                // Queue in NZB order, but start every task in the bounded window now.
                // The reader awaits the tasks in channel order, so delivery remains ordered.
                var openedStream = i == 0
                    ? Interlocked.Exchange(ref _openedFirstSegment, null)
                    : null;
                var streamTask = i == 0 && _progressiveFirstSegment
                    ? OpenProgressiveSegment(segmentId, openedStream, cancellationToken)
                    : DownloadSegment(segmentId, openedStream, cancellationToken);
                Interlocked.Increment(ref _queuedTasks);
                if (!_streamTasks.Writer.TryWrite(streamTask))
                {
                    Interlocked.Decrement(ref _queuedTasks);
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

    private async Task<Stream> OpenProgressiveSegment(
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken)
    {
        Stream? stream = openedStream;
        try
        {
            _onSegmentRequested?.Invoke(SegmentId.Normalize(segmentId));
            var cache = _segmentCache is { CapacityBytes: > 0 } ? _segmentCache : null;
            if (cache?.TryGet(segmentId, out var cached) == true)
            {
                if (stream is not null)
                    await stream.DisposeAsync().ConfigureAwait(false);
                stream = null;
                return new MemoryStream(cached, writable: false);
            }

            YencHeader? headers = null;
            if (stream is null)
            {
                var response = await _usenetClient
                    .DecodedBodyAsync(segmentId, cancellationToken)
                    .ConfigureAwait(false);
                stream = response.Stream;
                headers = await response.Stream.GetYencHeadersAsync(cancellationToken).ConfigureAwait(false)
                          ?? throw new InvalidDataException(
                              $"Article <{SegmentId.Normalize(segmentId)}> carried no yEnc headers.");
            }
            else if (stream is YencStream yencStream)
            {
                headers = await yencStream.GetYencHeadersAsync(cancellationToken).ConfigureAwait(false)
                          ?? throw new InvalidDataException(
                              $"Article <{SegmentId.Normalize(segmentId)}> carried no yEnc headers.");
            }

            if (cache is not null && headers is { PartSize: var partSize } && partSize > cache.CapacityBytes)
                cache = null;

            var result = stream
                         ?? throw new InvalidDataException(
                             $"Article <{SegmentId.Normalize(segmentId)}> returned no decoded stream.");
            stream = null;
            return cache is null
                ? result
                : new ProgressiveSegmentCacheStream(result, segmentId, cache);
        }
        catch
        {
            if (stream is not null)
                await stream.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<Stream> DownloadSegment
    (
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken
    )
    {
        try
        {
            _onSegmentRequested?.Invoke(SegmentId.Normalize(segmentId));
        }
        catch
        {
            if (openedStream is not null)
                await openedStream.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        var bytes = await GetSegmentBytes(segmentId, openedStream, cancellationToken).ConfigureAwait(false);
        return new MemoryStream(bytes, writable: false);
    }

    private async Task<byte[]> GetSegmentBytes(
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken)
    {
        if (_segmentCache is not { CapacityBytes: > 0 } cache)
            return await DownloadSegmentBytes(segmentId, openedStream, cancellationToken).ConfigureAwait(false);

        // GetOrAdd invokes a newly selected factory synchronously. Transfer ownership
        // of the already-open BODY only to that factory; a cache hit or an existing
        // in-flight transfer disposes the redundant probe immediately.
        Stream? candidate = openedStream;
        Task<byte[]> task;
        try
        {
            task = cache.GetOrAddAsync(
                segmentId,
                ct => DownloadSegmentBytes(
                    segmentId,
                    Interlocked.Exchange(ref candidate, null),
                    ct),
                cancellationToken);
        }
        finally
        {
            var unused = Interlocked.Exchange(ref candidate, null);
            if (unused is not null)
                await unused.DisposeAsync().ConfigureAwait(false);
        }

        return await task.ConfigureAwait(false);
    }

    private async Task<byte[]> DownloadSegmentBytes(
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken)
    {
        Exception? lastFailure = null;
        var initialStream = openedStream;
        try
        {
            for (var attempt = 0; attempt <= _retryCount; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    Stream body;
                    if (initialStream is not null)
                    {
                        body = initialStream;
                        initialStream = null;
                    }
                    else
                    {
                        var bodyResponse = await _usenetClient
                            .DecodedBodyAsync(segmentId, cancellationToken)
                            .ConfigureAwait(false);
                        body = bodyResponse.Stream;
                    }

                    await using (body.ConfigureAwait(false))
                    {
                        var headers = body is YencStream yencStream
                            ? await yencStream.GetYencHeadersAsync(cancellationToken).ConfigureAwait(false)
                            : null;
                        var capacity = headers?.PartSize is > 0 and <= int.MaxValue
                            ? checked((int)headers.PartSize)
                            : 0;
                        using var output = capacity > 0 ? new MemoryStream(capacity) : new MemoryStream();
                        await body.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
                        if (output.TryGetBuffer(out var buffer) && output.Length == buffer.Count)
                            return buffer.Array!;
                        return output.ToArray();
                    }
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
        finally
        {
            if (initialStream is not null)
                await initialStream.DisposeAsync().ConfigureAwait(false);
        }
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
                if (_onDemand)
                {
                    if (_nextSegmentIndex >= _segmentIds.Length)
                        return 0;

                    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                        cancellationToken, _cts.Token);
                    var index = _nextSegmentIndex;
                    var openedStream = index == 0
                        ? Interlocked.Exchange(ref _openedFirstSegment, null)
                        : null;
                    _stream = await DownloadSegment(
                        _segmentIds.Span[index],
                        openedStream,
                        linked.Token).ConfigureAwait(false);
                    _nextSegmentIndex++;
                }
                else
                {
                    if (!await _streamTasks.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false)) return 0;
                    if (!_streamTasks.Reader.TryRead(out var streamTask)) return 0;
                    Interlocked.Decrement(ref _queuedTasks);
                    _queueAdvanced.Release();
                    _stream = await streamTask.ConfigureAwait(false);
                }
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
        _openedFirstSegment?.Dispose();
        _openedFirstSegment = null;

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
        Action<string>? onSegmentRequested = null,
        Stream? openedFirstSegment = null,
        SegmentCache? segmentCache = null,
        bool progressiveFirstSegment = false)
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _onSegmentRequested = onSegmentRequested;
        if (openedFirstSegment is not null
            && progressiveFirstSegment
            && segmentCache is { CapacityBytes: > 0 }
            && !_segmentIds.IsEmpty)
        {
            var firstId = _segmentIds.Span[0];
            if (segmentCache.TryGet(firstId, out var cached))
            {
                openedFirstSegment.Dispose();
                _stream = new MemoryStream(cached, writable: false);
            }
            else
            {
                _stream = new ProgressiveSegmentCacheStream(openedFirstSegment, firstId, segmentCache);
            }
        }
        else
        {
            _stream = openedFirstSegment;
        }
        _currentIndex = openedFirstSegment is null ? 0 : 1;
        if (openedFirstSegment is not null && !_segmentIds.IsEmpty)
            _onSegmentRequested?.Invoke(SegmentId.Normalize(_segmentIds.Span[0]));
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

internal sealed class ProgressiveSegmentCacheStream(
    Stream inner,
    string segmentId,
    SegmentCache cache) : FastReadOnlyNonSeekableStream
{
    private readonly MemoryStream _copy = new();
    private bool _complete;
    private int _draining;

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (read > 0)
        {
            await _copy.WriteAsync(buffer[..read], cancellationToken).ConfigureAwait(false);
            return read;
        }

        if (!_complete)
        {
            _complete = true;
            cache.Store(segmentId, _copy.ToArray());
        }
        return 0;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_complete && Interlocked.Exchange(ref _draining, 1) == 0)
            _ = DrainAndCacheAsync();
        else if (disposing && Volatile.Read(ref _draining) == 0)
            DisposeResources();
        base.Dispose(disposing);
    }

    public override ValueTask DisposeAsync()
    {
        if (!_complete && Interlocked.Exchange(ref _draining, 1) == 0)
            _ = DrainAndCacheAsync();
        else if (Volatile.Read(ref _draining) == 0)
            DisposeResources();
        GC.SuppressFinalize(this);
        return ValueTask.CompletedTask;
    }

    private async Task DrainAndCacheAsync()
    {
        try
        {
            var buffer = new byte[81920];
            while (true)
            {
                var read = await inner.ReadAsync(buffer, CancellationToken.None).ConfigureAwait(false);
                if (read == 0)
                    break;
                await _copy.WriteAsync(buffer.AsMemory(0, read), CancellationToken.None).ConfigureAwait(false);
            }
            _complete = true;
            cache.Store(segmentId, _copy.ToArray());
        }
        catch
        {
            // A failed/invalid article is never committed; a later request retries it.
        }
        finally
        {
            DisposeResources();
        }
    }

    private void DisposeResources()
    {
        inner.Dispose();
        _copy.Dispose();
    }
}
