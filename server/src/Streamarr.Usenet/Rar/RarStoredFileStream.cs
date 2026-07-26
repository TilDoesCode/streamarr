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
    private readonly string? _password;
    private readonly Dictionary<int, byte[]> _keyCache = new();

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
    /// <param name="password">
    /// The release's password, required whenever <paramref name="file"/>.IsEncrypted is
    /// true. Each volume's AES-256 key is derived lazily from its own slice's crypto
    /// params (salt can legitimately differ per volume; SharpCompress's own decompression
    /// confirms encryption resets per volume, not once for the whole file) and cached.
    /// </param>
    public RarStoredFileStream(
        RarStoredFile file,
        Func<int, CancellationToken, ValueTask<Stream>> openPart,
        string? password = null)
    {
        if (file.IsEncrypted && password is null)
            throw new ArgumentException("An encrypted RAR file requires its password.", nameof(password));

        _file = file;
        _openPart = openPart;
        _password = password;
    }

    public override bool CanSeek => true;
    public override long Length => _file.Size;

    public override long Position
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _position;
        }
        set => Seek(value, SeekOrigin.Begin);
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
                SeekOrigin.End => checked(_file.Size + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
        }
        catch (OverflowException exception)
        {
            throw new IOException("The requested RAR seek offset overflowed.", exception);
        }

        if (absoluteOffset < 0)
            throw new IOException("Cannot seek before the beginning of the stream.");

        _position = absoluteOffset;
        return _position;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        if (_position >= _file.Size || buffer.Length == 0) return 0;

        var sliceIndex = FindSliceIndex(_position);
        var slice = _file.Slices[sliceIndex];

        if (slice.Crypto is null)
        {
            var read = await ReadPlainAsync(slice, buffer, cancellationToken).ConfigureAwait(false);
            _position += read;
            return read;
        }

        var decrypted = await ReadEncryptedAsync(slice, buffer.Length, cancellationToken).ConfigureAwait(false);
        if (decrypted.Length == 0) return 0;
        decrypted.CopyTo(buffer);
        _position += decrypted.Length;
        return decrypted.Length;
    }

    private async ValueTask<int> ReadPlainAsync(RarStoredFileSlice slice, Memory<byte> buffer, CancellationToken ct)
    {
        await SeekPartToAsync(slice, _position, ct).ConfigureAwait(false);

        // never read past the end of the slice (the next bytes in the volume are headers)
        var remainingInSlice = slice.ByteRangeWithinFile.EndExclusive - _position;
        var toRead = (int)Math.Min(buffer.Length, remainingInSlice);
        return await _currentPartStream!.ReadAsync(buffer[..toRead], ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Decrypts as much of the requested range as fits within <paramref name="slice"/>.
    /// Each volume's contribution to an encrypted file is its own independent AES-256-CBC
    /// stream (confirmed against SharpCompress's own decompression of a multi-volume
    /// fixture): the chain always restarts from this slice's own <see cref="RarFileCrypto.InitV"/>
    /// at its first plaintext byte, never from a previous volume's trailing ciphertext. So,
    /// unlike an unencrypted read, this never needs to cross into a different volume.
    /// </summary>
    private async ValueTask<ReadOnlyMemory<byte>> ReadEncryptedAsync(
        RarStoredFileSlice slice, int requestedLength, CancellationToken ct)
    {
        const int blockSize = RarAesCbcDecryptor.BlockSize;
        var crypto = slice.Crypto!;

        // never read past the end of the slice (the next bytes in the volume are headers)
        var remainingInSlice = slice.ByteRangeWithinFile.EndExclusive - _position;
        var toRead = (int)Math.Min(requestedLength, remainingInSlice);
        if (toRead <= 0) return ReadOnlyMemory<byte>.Empty;

        var sliceStart = slice.ByteRangeWithinFile.StartInclusive;
        var positionInSlice = _position - sliceStart;
        var blockStartInSlice = positionInSlice - positionInSlice % blockSize;
        var blockEndInSlice = positionInSlice + toRead;
        var alignedEndInSlice = (blockEndInSlice + blockSize - 1) / blockSize * blockSize;
        var cipherLength = checked((int)(alignedEndInSlice - blockStartInSlice));

        await SeekPartToAsync(slice, sliceStart + blockStartInSlice, ct).ConfigureAwait(false);
        var cipherBuffer = new byte[cipherLength];
        await _currentPartStream!.ReadExactlyAsync(cipherBuffer, ct).ConfigureAwait(false);

        var previousBlock = blockStartInSlice == 0
            ? crypto.InitV
            : await ReadPreviousCiphertextBlockAsync(slice, blockStartInSlice, ct).ConfigureAwait(false);

        var key = GetOrDeriveKey(slice.PartIndex, crypto);
        var plaintext = RarAesCbcDecryptor.Decrypt(key, previousBlock, cipherBuffer);
        var sourceOffset = (int)(positionInSlice - blockStartInSlice);
        return plaintext.AsMemory(sourceOffset, toRead);
    }

    /// <summary>Re-reads the 16 raw ciphertext bytes immediately preceding <paramref name="blockStartInSlice"/>,
    /// within the same slice/volume (CBC never crosses a volume boundary here).</summary>
    private async ValueTask<byte[]> ReadPreviousCiphertextBlockAsync(
        RarStoredFileSlice slice, long blockStartInSlice, CancellationToken ct)
    {
        const int blockSize = RarAesCbcDecryptor.BlockSize;
        await SeekPartToAsync(slice, slice.ByteRangeWithinFile.StartInclusive + blockStartInSlice - blockSize, ct)
            .ConfigureAwait(false);
        var previousBlock = new byte[blockSize];
        await _currentPartStream!.ReadExactlyAsync(previousBlock, ct).ConfigureAwait(false);
        return previousBlock;
    }

    private byte[] GetOrDeriveKey(int partIndex, RarFileCrypto crypto)
    {
        if (_keyCache.TryGetValue(partIndex, out var cached))
            return cached;

        var key = RarAesCbcDecryptor.DeriveKey(_password!, crypto.Salt, crypto.Lg2Count);
        _keyCache[partIndex] = key;
        return key;
    }

    /// <summary>Opens (or reuses) the volume stream backing <paramref name="slice"/> and
    /// seeks it to the raw offset corresponding to file-relative <paramref name="fileOffset"/>.</summary>
    private async ValueTask SeekPartToAsync(RarStoredFileSlice slice, long fileOffset, CancellationToken ct)
    {
        if (_currentPartStream == null || _currentPartIndex != slice.PartIndex)
        {
            if (_currentPartStream != null)
                await _currentPartStream.DisposeAsync().ConfigureAwait(false);
            _currentPartStream = null; // don't hold a stale reference if openPart throws
            _currentPartStream = await _openPart(slice.PartIndex, ct).ConfigureAwait(false);
            _currentPartIndex = slice.PartIndex;
        }

        var offsetWithinSlice = fileOffset - slice.ByteRangeWithinFile.StartInclusive;
        var rawOffset = slice.ByteRangeWithinPart.StartInclusive + offsetWithinSlice;
        if (_currentPartStream.Position != rawOffset)
            _currentPartStream.Seek(rawOffset, SeekOrigin.Begin);
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
