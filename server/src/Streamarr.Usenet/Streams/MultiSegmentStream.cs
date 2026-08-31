// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Streams/{MultiSegmentStream,UnbufferedMultiSegmentStream}.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr: the buffered
// variant uses pooled DecodedBodyAsync read-ahead instead of nzbdav's
// exclusive-connection mechanism; pooled connections are still released as soon
// as each article body has fully arrived (onConnectionReadyAgain).

using System.Diagnostics;
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
    private readonly SegmentMetadataCache? _segmentMetadata;
    private readonly int _retryCount;
    private readonly Action<string>? _onSegmentRequested;
    private readonly Action<SegmentTransferEvent>? _onTransfer;
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
        bool disableReadAhead = false,
        SegmentMetadataCache? segmentMetadata = null,
        Action<SegmentTransferEvent>? onTransfer = null,
        int transientRetryCount = 0,
        Func<int, TimeSpan>? transientRetryDelay = null
    )
    {
        return articleBufferSize == 0
            ? new UnbufferedMultiSegmentStream(
                segmentIds,
                usenetClient,
                onSegmentRequested,
                openedFirstSegment,
                segmentCache,
                progressiveFirstSegment,
                onTransfer)
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
                disableReadAhead,
                segmentMetadata,
                onTransfer,
                transientRetryCount,
                transientRetryDelay);
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
        bool disableReadAhead,
        SegmentMetadataCache? segmentMetadata = null,
        Action<SegmentTransferEvent>? onTransfer = null,
        int transientRetryCount = 0,
        Func<int, TimeSpan>? transientRetryDelay = null
    )
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _segmentCache = segmentCache;
        _segmentMetadata = segmentMetadata;
        _retryCount = retryCount is >= 0 and <= 10
            ? retryCount
            : throw new ArgumentOutOfRangeException(nameof(retryCount));
        _transientRetryCount = transientRetryCount is >= 0 and <= 10
            ? transientRetryCount
            : throw new ArgumentOutOfRangeException(nameof(transientRetryCount));
        _transientRetryDelay = transientRetryCount == 0
            ? transientRetryDelay
            : transientRetryDelay ?? throw new ArgumentNullException(nameof(transientRetryDelay));
        _onSegmentRequested = onSegmentRequested;
        _onTransfer = onTransfer;
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
    private readonly int _transientRetryCount;
    private readonly Func<int, TimeSpan>? _transientRetryDelay;

    private static readonly bool Trace = Environment.GetEnvironmentVariable("STREAMARR_NNTP_TRACE") == "1";
    private static int _instanceCounter;
    private readonly int _instanceId = Interlocked.Increment(ref _instanceCounter);

    private async Task DownloadSegments(CancellationToken cancellationToken)
    {
        if (Trace)
            Console.Error.WriteLine($"[nntp-trace] {DateTime.UtcNow:HH:mm:ss.fff} MSS#{_instanceId} START segs={_segmentIds.Length} startupWindow={_startupReadAhead}/{_startupReadAheadSegments} steady={_steadyReadAhead}");
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
            if (Trace)
                Console.Error.WriteLine($"[nntp-trace] {DateTime.UtcNow:HH:mm:ss.fff} MSS#{_instanceId} DOWNLOADER-EXIT");
            _streamTasks.Writer.TryComplete();
        }
    }

    private async Task<Stream> OpenProgressiveSegment(
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken)
    {
        Stream? stream = openedStream;
        var started = Stopwatch.GetTimestamp();
        try
        {
            _onSegmentRequested?.Invoke(SegmentId.Normalize(segmentId));
            Notify(segmentId, SegmentTransferStage.Queued);
            var cache = _segmentCache is { CapacityBytes: > 0 } ? _segmentCache : null;
            if (cache?.TryGet(segmentId, out var cached) == true)
            {
                if (stream is not null)
                    await stream.DisposeAsync().ConfigureAwait(false);
                stream = null;
                Notify(segmentId, SegmentTransferStage.Cached, cached.LongLength, 0);
                return new MemoryStream(cached, writable: false);
            }

            Notify(segmentId, SegmentTransferStage.Downloading);
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

            if (headers is not null)
                _segmentMetadata?.Store(segmentId, headers.PartOffset, headers.PartSize);
            if (cache is not null && headers is { PartSize: var partSize } && partSize > cache.CapacityBytes)
                cache = null;

            var result = stream
                         ?? throw new InvalidDataException(
                             $"Article <{SegmentId.Normalize(segmentId)}> returned no decoded stream.");
            stream = null;
            var observed = cache is null
                ? result
                : new ProgressiveSegmentCacheStream(result, segmentId, cache);
            return new ObservedSegmentStream(observed, segmentId, started, Notify);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (stream is not null)
                await stream.DisposeAsync().ConfigureAwait(false);
            Notify(
                segmentId,
                SegmentTransferStage.Partial,
                durationMs: Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            throw;
        }
        catch (Exception exception)
        {
            if (stream is not null)
                await stream.DisposeAsync().ConfigureAwait(false);
            NotifyFailure(segmentId, exception);
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
            Notify(segmentId, SegmentTransferStage.Queued);
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

        if (cache.TryGet(segmentId, out var cached))
        {
            if (openedStream is not null)
                await openedStream.DisposeAsync().ConfigureAwait(false);
            Notify(segmentId, SegmentTransferStage.Cached, cached.LongLength, 0);
            return cached;
        }

        // GetOrAdd invokes a newly selected factory synchronously. Transfer ownership
        // of the already-open BODY only to that factory; a cache hit or an existing
        // in-flight transfer disposes the redundant probe immediately.
        Stream? candidate = openedStream;
        Task<byte[]> task;
        var factoryStarted = 0;
        var waitStarted = Stopwatch.GetTimestamp();
        try
        {
            task = cache.GetOrAddAsync(
                segmentId,
                ct =>
                {
                    Interlocked.Exchange(ref factoryStarted, 1);
                    return DownloadSegmentBytes(
                        segmentId,
                        Interlocked.Exchange(ref candidate, null),
                        ct);
                },
                cancellationToken);
        }
        finally
        {
            var unused = Interlocked.Exchange(ref candidate, null);
            if (unused is not null)
                await unused.DisposeAsync().ConfigureAwait(false);
        }

        try
        {
            var bytes = await task.ConfigureAwait(false);
            if (Volatile.Read(ref factoryStarted) == 0)
            {
                Notify(
                    segmentId,
                    SegmentTransferStage.Cached,
                    bytes.LongLength,
                    Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds);
            }
            return bytes;
        }
        catch (OperationCanceledException) when (
            cancellationToken.IsCancellationRequested
            && Volatile.Read(ref factoryStarted) == 0)
        {
            Notify(
                segmentId,
                SegmentTransferStage.Partial,
                durationMs: Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds);
            throw;
        }
    }

    private async Task<byte[]> DownloadSegmentBytes(
        string segmentId,
        Stream? openedStream,
        CancellationToken cancellationToken)
    {
        Exception? lastFailure = null;
        var initialStream = openedStream;
        var started = Stopwatch.GetTimestamp();
        long partialBytes = 0;
        var attemptsMade = 0;
        Notify(segmentId, SegmentTransferStage.Downloading);
        try
        {
            for (var attempt = 0; attempt <= _retryCount; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    attemptsMade++;
                    return await DownloadOnce().ConfigureAwait(false);
                }
                catch (Exception e) when (e is not OperationCanceledException and not UsenetArticleNotFoundException)
                {
                    lastFailure = e;
                }
            }

            for (var delayedAttempt = 1;
                 delayedAttempt <= _transientRetryCount && IsDelayedRetryable(lastFailure);
                 delayedAttempt++)
            {
                var delay = _transientRetryDelay!(delayedAttempt);
                if (delay < TimeSpan.Zero)
                    throw new ArgumentOutOfRangeException(
                        nameof(_transientRetryDelay),
                        "The delayed retry function returned a negative delay.");

                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
                try
                {
                    attemptsMade++;
                    return await DownloadOnce().ConfigureAwait(false);
                }
                catch (Exception e) when (e is not OperationCanceledException and not UsenetArticleNotFoundException)
                {
                    lastFailure = e;
                }
            }

            throw new IOException(
                $"NNTP article <{SegmentId.Normalize(segmentId)}> failed after {attemptsMade} attempts.",
                lastFailure);

            async Task<byte[]> DownloadOnce()
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
                    if (headers is not null)
                        _segmentMetadata?.Store(segmentId, headers.PartOffset, headers.PartSize);
                    var capacity = headers?.PartSize is > 0 and <= int.MaxValue
                        ? checked((int)headers.PartSize)
                        : 0;
                    using var output = capacity > 0 ? new MemoryStream(capacity) : new MemoryStream();
                    try
                    {
                        await body.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        partialBytes = Math.Max(partialBytes, output.Length);
                    }
                    var bytes = output.TryGetBuffer(out var buffer) && output.Length == buffer.Count
                        ? buffer.Array!
                        : output.ToArray();
                    Notify(
                        segmentId,
                        SegmentTransferStage.Downloaded,
                        bytes.LongLength,
                        Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                    return bytes;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Notify(
                segmentId,
                SegmentTransferStage.Partial,
                partialBytes,
                durationMs: Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            throw;
        }
        catch (Exception exception)
        {
            NotifyFailure(segmentId, exception, started);
            throw;
        }
        finally
        {
            if (initialStream is not null)
                await initialStream.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static bool IsDelayedRetryable(Exception? exception)
        => exception is TimeoutException
            or IOException
            or UsenetConnectionException
            or UsenetProtocolException
            or UsenetNotConnectedException
            or CouldNotConnectToUsenetException;

    private void Notify(
        string segmentId,
        SegmentTransferStage stage,
        long bytes = 0,
        double? durationMs = null,
        string? errorType = null,
        string? errorMessage = null)
        => _onTransfer?.Invoke(new SegmentTransferEvent
        {
            SegmentId = SegmentId.Normalize(segmentId),
            Stage = stage,
            Bytes = Math.Max(0, bytes),
            DurationMs = durationMs,
            ErrorType = errorType,
            ErrorMessage = errorMessage,
        });

    private void NotifyFailure(string segmentId, Exception exception, long? started = null)
    {
        var diagnostic = DiagnosticException(exception);
        Notify(
            segmentId,
            SegmentTransferStage.Failed,
            durationMs: started is null ? null : Stopwatch.GetElapsedTime(started.Value).TotalMilliseconds,
            errorType: diagnostic.GetType().Name,
            errorMessage: SafeError(diagnostic));
    }

    private static Exception DiagnosticException(Exception exception)
        => exception.InnerException is null ? exception : exception.GetBaseException();

    private static string SafeError(Exception exception)
    {
        var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 512 ? message : message[..512];
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
        if (Trace)
            Console.Error.WriteLine($"[nntp-trace] {DateTime.UtcNow:HH:mm:ss.fff} MSS#{_instanceId} DISPOSE nextIdx={_nextSegmentIndex} queued={_queuedTasks}");
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

internal sealed class ObservedSegmentStream(
    Stream inner,
    string segmentId,
    long started,
    Action<string, SegmentTransferStage, long, double?, string?, string?> notify)
    : FastReadOnlyNonSeekableStream
{
    private const long ProgressIntervalBytes = 256 * 1024;
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromMilliseconds(250);
    private long _bytes;
    private long _lastProgressBytes;
    private long _lastProgressAt;
    private int _terminal;

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read > 0)
            {
                _bytes += read;
                ReportProgressIfDue();
                return read;
            }

            Complete(SegmentTransferStage.Downloaded);
            return 0;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Complete(SegmentTransferStage.Partial);
            throw;
        }
        catch (Exception exception)
        {
            var diagnostic = exception.InnerException is null ? exception : exception.GetBaseException();
            Complete(
                SegmentTransferStage.Failed,
                diagnostic.GetType().Name,
                SafeError(diagnostic));
            throw;
        }
    }

    private void ReportProgressIfDue()
    {
        var now = Stopwatch.GetTimestamp();
        if (_lastProgressAt == 0)
            _lastProgressAt = started;
        if (_bytes - _lastProgressBytes < ProgressIntervalBytes
            && Stopwatch.GetElapsedTime(_lastProgressAt, now) < ProgressInterval)
        {
            return;
        }

        _lastProgressBytes = _bytes;
        _lastProgressAt = now;
        notify(
            segmentId,
            SegmentTransferStage.Downloading,
            _bytes,
            Stopwatch.GetElapsedTime(started, now).TotalMilliseconds,
            null,
            null);
    }

    private void Complete(
        SegmentTransferStage stage,
        string? errorType = null,
        string? errorMessage = null)
    {
        if (Interlocked.Exchange(ref _terminal, 1) != 0)
            return;
        notify(
            segmentId,
            stage,
            Interlocked.Read(ref _bytes),
            Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            errorType,
            errorMessage);
    }

    private static string SafeError(Exception exception)
    {
        var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 512 ? message : message[..512];
    }

    protected override void Dispose(bool disposing)
    {
        if (!disposing)
            return;
        Complete(SegmentTransferStage.Partial);
        inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        Complete(SegmentTransferStage.Partial);
        await inner.DisposeAsync().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }
}

/// <summary>
/// Concatenates the yEnc-decoded bodies of consecutive segments with no
/// read-ahead: each segment is downloaded on demand.
/// </summary>
public class UnbufferedMultiSegmentStream : FastReadOnlyNonSeekableStream
{
    private const long ProgressIntervalBytes = 256 * 1024;
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromMilliseconds(250);
    private readonly Memory<string> _segmentIds;
    private readonly INntpClient _usenetClient;
    private Stream? _stream;
    private int _currentIndex;
    private bool _disposed;
    private readonly Action<string>? _onSegmentRequested;
    private readonly Action<SegmentTransferEvent>? _onTransfer;
    private string? _currentSegmentId;
    private long _currentStarted;
    private long _currentBytes;
    private long _lastProgressBytes;
    private long _lastProgressAt;
    private bool _currentCached;

    public UnbufferedMultiSegmentStream(
        Memory<string> segmentIds,
        INntpClient usenetClient,
        Action<string>? onSegmentRequested = null,
        Stream? openedFirstSegment = null,
        SegmentCache? segmentCache = null,
        bool progressiveFirstSegment = false,
        Action<SegmentTransferEvent>? onTransfer = null)
    {
        _segmentIds = segmentIds;
        _usenetClient = usenetClient;
        _onSegmentRequested = onSegmentRequested;
        _onTransfer = onTransfer;
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
                _currentCached = true;
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
        {
            _currentSegmentId = SegmentId.Normalize(_segmentIds.Span[0]);
            _onSegmentRequested?.Invoke(SegmentId.Normalize(_segmentIds.Span[0]));
            Notify(_currentSegmentId, SegmentTransferStage.Queued);
            if (_currentCached && _stream is MemoryStream memory)
                Notify(_currentSegmentId, SegmentTransferStage.Cached, memory.Length, 0);
            else
            {
                _currentStarted = Stopwatch.GetTimestamp();
                _lastProgressAt = _currentStarted;
                Notify(_currentSegmentId, SegmentTransferStage.Downloading);
            }
        }
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (buffer.IsEmpty) return 0;

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                if (_stream == null)
                {
                    if (_currentIndex >= _segmentIds.Length) return 0;
                    var segmentId = _segmentIds.Span[_currentIndex++];
                    _currentSegmentId = SegmentId.Normalize(segmentId);
                    _currentBytes = 0;
                    _currentCached = false;
                    _onSegmentRequested?.Invoke(_currentSegmentId);
                    Notify(_currentSegmentId, SegmentTransferStage.Queued);
                    _currentStarted = Stopwatch.GetTimestamp();
                    _lastProgressBytes = 0;
                    _lastProgressAt = _currentStarted;
                    Notify(_currentSegmentId, SegmentTransferStage.Downloading);
                    var body = await _usenetClient
                        .DecodedBodyAsync(segmentId, cancellationToken)
                        .ConfigureAwait(false);
                    _stream = body.Stream;
                }

                var read = await _stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read > 0)
                {
                    _currentBytes += read;
                    ReportProgressIfDue();
                    return read;
                }

                await _stream.DisposeAsync().ConfigureAwait(false);
                _stream = null;
                if (!_currentCached && _currentSegmentId is not null)
                {
                    Notify(
                        _currentSegmentId,
                        SegmentTransferStage.Downloaded,
                        _currentBytes,
                        Stopwatch.GetElapsedTime(_currentStarted).TotalMilliseconds);
                }
                _currentSegmentId = null;
            }
        }
        catch (Exception exception)
        {
            if (_currentSegmentId is not null)
            {
                var cancelled = exception is OperationCanceledException
                    && cancellationToken.IsCancellationRequested;
                var diagnostic = exception.InnerException is null ? exception : exception.GetBaseException();
                Notify(
                    _currentSegmentId,
                    cancelled ? SegmentTransferStage.Partial : SegmentTransferStage.Failed,
                    _currentBytes,
                    _currentStarted == 0 ? null : Stopwatch.GetElapsedTime(_currentStarted).TotalMilliseconds,
                    cancelled ? null : diagnostic.GetType().Name,
                    cancelled ? null : SafeError(diagnostic));
                _currentSegmentId = null;
            }
            throw;
        }

        return 0;
    }

    private void ReportProgressIfDue()
    {
        if (_currentCached || _currentSegmentId is null || _currentStarted == 0)
            return;

        var now = Stopwatch.GetTimestamp();
        if (_currentBytes - _lastProgressBytes < ProgressIntervalBytes
            && Stopwatch.GetElapsedTime(_lastProgressAt, now) < ProgressInterval)
        {
            return;
        }

        _lastProgressBytes = _currentBytes;
        _lastProgressAt = now;
        Notify(
            _currentSegmentId,
            SegmentTransferStage.Downloading,
            _currentBytes,
            Stopwatch.GetElapsedTime(_currentStarted, now).TotalMilliseconds);
    }

    private void Notify(
        string segmentId,
        SegmentTransferStage stage,
        long bytes = 0,
        double? durationMs = null,
        string? errorType = null,
        string? errorMessage = null)
        => _onTransfer?.Invoke(new SegmentTransferEvent
        {
            SegmentId = segmentId,
            Stage = stage,
            Bytes = Math.Max(0, bytes),
            DurationMs = durationMs,
            ErrorType = errorType,
            ErrorMessage = errorMessage,
        });

    private static string SafeError(Exception exception)
    {
        var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 512 ? message : message[..512];
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
        if (_currentSegmentId is not null && !_currentCached)
            Notify(
                _currentSegmentId,
                SegmentTransferStage.Partial,
                _currentBytes,
                _currentStarted == 0 ? null : Stopwatch.GetElapsedTime(_currentStarted).TotalMilliseconds);
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
