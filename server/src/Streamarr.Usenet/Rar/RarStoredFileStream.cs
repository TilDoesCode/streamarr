// Written for Streamarr. Presents a stored RAR entry (possibly spanning multiple
// volumes) as one seekable read-only stream, given a way to open each volume as a
// seekable stream (a FileStream in tests, an NzbFileStream in production).

using Streamarr.Usenet.Streams;

namespace Streamarr.Usenet.Rar;

/// <summary>
/// A seekable, read-only view of a stored (uncompressed) file inside a RAR set.
/// Reads translate file-relative offsets through the slice map to raw offsets in
/// the underlying volume streams — this is what makes seeking inside RAR'd media
/// cheap: no unpacking, just offset arithmetic.
/// </summary>
public sealed class RarStoredFileStream : FastReadOnlyStream
{
    private readonly RarStoredFile _file;
    private readonly Func<int, CancellationToken, ValueTask<Stream>> _openPart;

    private long _position;
    private int _currentPartIndex = -1;
    private Stream? _currentPartStream;
    private bool _disposed;

    /// <param name="file">The slice map of the stored file.</param>
    /// <param name="openPart">
    /// Opens the volume with the given part index as a seekable stream. The stream
    /// is owned (and disposed) by this instance; it is reused across reads until a
    /// different volume is needed.
    /// </param>
    public RarStoredFileStream(RarStoredFile file, Func<int, CancellationToken, ValueTask<Stream>> openPart)
    {
        _file = file;
        _openPart = openPart;
    }

    public override bool CanSeek => true;
    public override long Length => _file.Size;

    public override long Position
    {
        get => _position;
        set => Seek(value, SeekOrigin.Begin);
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        var absoluteOffset = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            SeekOrigin.End => _file.Size + offset,
            _ => throw new ArgumentOutOfRangeException(nameof(origin)),
        };

        if (absoluteOffset < 0)
            throw new IOException("Cannot seek before the beginning of the stream.");

        _position = absoluteOffset;
        return _position;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        if (_position >= _file.Size || buffer.Length == 0) return 0;

        // find the slice containing the current position (binary search)
        var sliceIndex = FindSliceIndex(_position);
        var slice = _file.Slices[sliceIndex];

        // open (or reuse) the volume stream backing this slice
        if (_currentPartStream == null || _currentPartIndex != slice.PartIndex)
        {
            if (_currentPartStream != null)
                await _currentPartStream.DisposeAsync().ConfigureAwait(false);
            _currentPartStream = null; // don't hold a stale reference if openPart throws
            _currentPartStream = await _openPart(slice.PartIndex, cancellationToken).ConfigureAwait(false);
            _currentPartIndex = slice.PartIndex;
        }

        // translate the file-relative position into a raw volume offset
        var offsetWithinSlice = _position - slice.ByteRangeWithinFile.StartInclusive;
        var rawOffset = slice.ByteRangeWithinPart.StartInclusive + offsetWithinSlice;
        if (_currentPartStream.Position != rawOffset)
            _currentPartStream.Seek(rawOffset, SeekOrigin.Begin);

        // never read past the end of the slice (the next bytes in the volume are headers)
        var remainingInSlice = slice.ByteRangeWithinFile.EndExclusive - _position;
        var toRead = (int)Math.Min(buffer.Length, remainingInSlice);

        var read = await _currentPartStream.ReadAsync(buffer[..toRead], cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    private int FindSliceIndex(long position)
    {
        var slices = _file.Slices;
        int lo = 0, hi = slices.Count - 1;
        while (lo <= hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            var range = slices[mid].ByteRangeWithinFile;
            if (position < range.StartInclusive) hi = mid - 1;
            else if (position >= range.EndExclusive) lo = mid + 1;
            else return mid;
        }

        throw new IOException($"Position {position} is not mapped by the RAR slice index.");
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed) return;
        if (disposing) _currentPartStream?.Dispose();
        _disposed = true;
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        if (_currentPartStream != null)
            await _currentPartStream.DisposeAsync().ConfigureAwait(false);
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
