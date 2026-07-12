// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Streams/NzbFileStream.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root.

using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Utils;

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
    int articleBufferSize
) : FastReadOnlyStream
{
    private long _position;
    private bool _disposed;
    private Stream? _innerStream;

    public override bool CanSeek => true;
    public override long Length => fileSize;

    public override long Position
    {
        get => _position;
        set => Seek(value, SeekOrigin.Begin);
    }

    public override void Flush()
    {
        _innerStream?.Flush();
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (_position >= fileSize) return 0;
        _innerStream ??= await GetFileStream(_position, cancellationToken).ConfigureAwait(false);
        var read = await _innerStream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        var absoluteOffset = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            SeekOrigin.End => fileSize + offset,
            _ => throw new ArgumentOutOfRangeException(nameof(origin)),
        };
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
                return new LongRange(header.PartOffset, header.PartOffset + header.PartSize);
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
        return MultiSegmentStream.Create(segmentIds, usenetClient, articleBufferSize, cancellationToken);
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
}
