// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Streams/NzbFileStream.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root.

using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Utils;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Streams;

/// <summary>
/// A seekable, read-only view of the decoded file carried by an NZB's segments.
/// Seeking uses interpolation search over the segments' yEnc part offsets, so a
/// seek anywhere in the file costs only a handful of header probes.
/// </summary>
public class NzbFileStream(
    string[] fileSegmentIds,
    long fileSize,
    INntpClient usenetClient,
    int articleBufferSize,
    SegmentCache? segmentCache = null,
    int articleRetryCount = 2,
    Action<string>? onSegmentRequested = null,
    int startupArticleBufferSize = 0,
    int startupReadAheadSegments = 0,
    Stream? openedFirstSegment = null
) : FastReadOnlyStream
{
    private readonly bool _validated = ValidateArguments(
        fileSegmentIds,
        fileSize,
        articleBufferSize,
        startupArticleBufferSize,
        startupReadAheadSegments);
    private long _position;
    private bool _disposed;
    private Stream? _innerStream;
    private Stream? _openedFirstSegment = openedFirstSegment;

    public override bool CanSeek
    {
        get
        {
            _ = _validated;
            return true;
        }
    }
    public override long Length => fileSize;

    public override long Position
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _position;
        }
        set => Seek(value, SeekOrigin.Begin);
    }

    public override void Flush()
    {
        _innerStream?.Flush();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (buffer.IsEmpty) return 0;
        if (_position >= fileSize) return 0;
        var remaining = fileSize - _position;
        if (buffer.Length > remaining)
            buffer = buffer[..checked((int)remaining)];
        _innerStream ??= await GetFileStream(_position, cancellationToken).ConfigureAwait(false);
        var read = await _innerStream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        long absoluteOffset;
        try
        {
            absoluteOffset = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(_position + offset),
                SeekOrigin.End => checked(fileSize + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
        }
        catch (OverflowException e)
        {
            throw new IOException("The requested seek offset overflowed.", e);
        }

        if (absoluteOffset < 0 || absoluteOffset > fileSize)
            throw new IOException("Cannot seek outside the decoded file.");
        if (_position == absoluteOffset) return _position;
        _position = absoluteOffset;
        var unopened = Interlocked.Exchange(ref _openedFirstSegment, null);
        unopened?.Dispose();
        _innerStream?.Dispose();
        _innerStream = null;
        return _position;
    }

    private async Task<(InterpolationSearch.Result Result, Stream Stream)> SeekSegment(
        long byteOffset,
        CancellationToken ct)
    {
        Stream? foundStream = null;
        try
        {
            var result = await InterpolationSearch.Find(
                byteOffset,
                new LongRange(0, fileSegmentIds.Length),
                new LongRange(0, fileSize),
                async (guess) =>
                {
                    var response = await usenetClient.DecodedBodyAsync(fileSegmentIds[guess], ct).ConfigureAwait(false);
                    var stream = response.Stream;
                    try
                    {
                        var header = await stream.GetYencHeadersAsync(ct).ConfigureAwait(false)
                                     ?? throw new InvalidDataException("The NNTP article carried no yEnc headers.");
                        var range = new LongRange(header.PartOffset, checked(header.PartOffset + header.PartSize));
                        if (range.Contains(byteOffset))
                            foundStream = stream;
                        else
                            await stream.DisposeAsync().ConfigureAwait(false);
                        return range;
                    }
                    catch
                    {
                        await stream.DisposeAsync().ConfigureAwait(false);
                        throw;
                    }
                },
                ct
            ).ConfigureAwait(false);
            var matchedStream = foundStream
                                ?? throw new InvalidDataException("Interpolation search lost its matched article.");
            foundStream = null;
            return (result, matchedStream);
        }
        catch
        {
            if (foundStream is not null)
                await foundStream.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<Stream> GetFileStream(long rangeStart, CancellationToken cancellationToken)
    {
        if (rangeStart == 0)
        {
            var opened = Interlocked.Exchange(ref _openedFirstSegment, null);
            try
            {
                return GetMultiSegmentStream(0, cancellationToken, opened);
            }
            catch
            {
                if (opened is not null)
                    await opened.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }

        var found = await SeekSegment(rangeStart, cancellationToken).ConfigureAwait(false);
        Stream? stream = null;
        try
        {
            stream = GetMultiSegmentStream(found.Result.FoundIndex, cancellationToken, found.Stream);
            await stream.DiscardBytesAsync(rangeStart - found.Result.FoundByteRange.StartInclusive, cancellationToken)
                .ConfigureAwait(false);
            return stream;
        }
        catch
        {
            if (stream is not null)
                await stream.DisposeAsync().ConfigureAwait(false);
            else
                await found.Stream.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private Stream GetMultiSegmentStream(
        int firstSegmentIndex,
        CancellationToken cancellationToken,
        Stream? openedFirstSegment = null)
    {
        var segmentIds = fileSegmentIds.AsMemory()[firstSegmentIndex..];
        var nearEnd = firstSegmentIndex >= fileSegmentIds.Length - 2;
        // The startup burst exists to hide cold-start latency at the head of the file. A
        // mid-file open (every resume/seek — ffmpeg issues several probing opens per seek)
        // must NOT re-arm it: each burst dumps a volley of concurrent High-priority reads
        // into the shared connection pool exactly when a resume is already contended, and
        // steady read-ahead is enough once playback is positioned.
        var initialOpen = firstSegmentIndex == 0;
        return MultiSegmentStream.Create(
            segmentIds,
            usenetClient,
            articleBufferSize,
            cancellationToken,
            segmentCache,
            articleRetryCount,
            onSegmentRequested,
            initialOpen ? startupArticleBufferSize : 0,
            initialOpen ? startupReadAheadSegments : 0,
            openedFirstSegment,
            progressiveFirstSegment: false,
            disableReadAhead: nearEnd && articleBufferSize > 0);
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        _innerStream?.Dispose();
        _openedFirstSegment?.Dispose();
        _openedFirstSegment = null;
        _disposed = true;
    }

    public override async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        if (_innerStream != null) await _innerStream.DisposeAsync().ConfigureAwait(false);
        if (_openedFirstSegment != null) await _openedFirstSegment.DisposeAsync().ConfigureAwait(false);
        _openedFirstSegment = null;
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private static bool ValidateArguments(
        string[] segmentIds,
        long length,
        int readAhead,
        int startupReadAhead,
        int startupSegments)
    {
        ArgumentNullException.ThrowIfNull(segmentIds);
        if (segmentIds.Length == 0 || segmentIds.Length > 1_000_000)
            throw new ArgumentException("A bounded non-empty segment list is required.", nameof(segmentIds));
        if (length is < 1 or > YencHeader.MaxFileSizeBytes)
            throw new ArgumentOutOfRangeException(nameof(length));
        if (readAhead is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(readAhead));
        if (startupReadAhead is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(startupReadAhead));
        if (startupSegments is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(startupSegments));
        foreach (var id in segmentIds)
            _ = SegmentId.Normalize(id);
        return true;
    }
}
