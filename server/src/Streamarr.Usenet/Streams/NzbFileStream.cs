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
    int articleRetryCount = 2
) : FastReadOnlyStream
{
    private readonly bool _validated = ValidateArguments(fileSegmentIds, fileSize, articleBufferSize);
    private long _position;
    private bool _disposed;
    private Stream? _innerStream;

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
        _innerStream?.Dispose();
        _innerStream = null;
        return _position;
    }

    private async Task<InterpolationSearch.Result> SeekSegment(long byteOffset, CancellationToken ct)
    {
        return await InterpolationSearch.Find(
            byteOffset,
            new LongRange(0, fileSegmentIds.Length),
            new LongRange(0, fileSize),
            async (guess) =>
            {
                var header = await usenetClient.GetYencHeadersAsync(fileSegmentIds[guess], ct).ConfigureAwait(false);
                return new LongRange(header.PartOffset, checked(header.PartOffset + header.PartSize));
            },
            ct
        ).ConfigureAwait(false);
    }

    private async Task<Stream> GetFileStream(long rangeStart, CancellationToken cancellationToken)
    {
        if (rangeStart == 0) return GetMultiSegmentStream(0, cancellationToken);
        var foundSegment = await SeekSegment(rangeStart, cancellationToken).ConfigureAwait(false);
        var stream = GetMultiSegmentStream(foundSegment.FoundIndex, cancellationToken);
        await stream.DiscardBytesAsync(rangeStart - foundSegment.FoundByteRange.StartInclusive, cancellationToken)
            .ConfigureAwait(false);
        return stream;
    }

    private Stream GetMultiSegmentStream(int firstSegmentIndex, CancellationToken cancellationToken)
    {
        var segmentIds = fileSegmentIds.AsMemory()[firstSegmentIndex..];
        return MultiSegmentStream.Create(
            segmentIds,
            usenetClient,
            articleBufferSize,
            cancellationToken,
            segmentCache,
            articleRetryCount);
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        _innerStream?.Dispose();
        _disposed = true;
    }

    public override async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        if (_innerStream != null) await _innerStream.DisposeAsync().ConfigureAwait(false);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private static bool ValidateArguments(string[] segmentIds, long length, int readAhead)
    {
        ArgumentNullException.ThrowIfNull(segmentIds);
        if (segmentIds.Length == 0 || segmentIds.Length > 1_000_000)
            throw new ArgumentException("A bounded non-empty segment list is required.", nameof(segmentIds));
        if (length is < 1 or > YencHeader.MaxFileSizeBytes)
            throw new ArgumentOutOfRangeException(nameof(length));
        if (readAhead is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(readAhead));
        foreach (var id in segmentIds)
            _ = SegmentId.Normalize(id);
        return true;
    }
}
