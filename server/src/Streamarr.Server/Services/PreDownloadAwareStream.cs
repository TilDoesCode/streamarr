namespace Streamarr.Server.Services;

/// <summary>
/// Reads an already materialized prefix locally and falls back to the seekable remote stream at
/// the first uncovered byte. Existing HTTP streams automatically benefit when a pre-download is
/// attached after playback has started.
/// </summary>
internal sealed class PreDownloadAwareStream(
    Stream remote,
    Func<PreDownloadCacheFile?> cacheAccessor) : Stream
{
    private FileStream? _local;
    private PreDownloadCacheFile? _openedCache;
    private long _position;

    public override bool CanRead => remote.CanRead;
    public override bool CanSeek => remote.CanSeek;
    public override bool CanWrite => false;
    public override long Length => remote.Length;
    public override long Position
    {
        get => _position;
        set => Seek(value, SeekOrigin.Begin);
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        ValidateBuffer(buffer, offset, count);
        var localRead = TryReadLocal(buffer.AsSpan(offset, count));
        if (localRead > 0)
            return localRead;
        if (IsCompletedLocalEof())
            return 0;
        AlignRemote();
        var read = remote.Read(buffer, offset, count);
        _position += read;
        return read;
    }

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        var localRead = await TryReadLocalAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (localRead > 0)
            return localRead;
        if (IsCompletedLocalEof())
            return 0;
        AlignRemote();
        var read = await remote.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    private int TryReadLocal(Span<byte> buffer)
    {
        var cache = cacheAccessor();
        var available = cache is null ? 0 : cache.DownloadedBytes - _position;
        if (available <= 0 || buffer.Length == 0 || !EnsureLocal(cache!))
            return 0;
        _local!.Position = _position;
        var read = _local.Read(buffer[..Math.Min(buffer.Length, checked((int)Math.Min(int.MaxValue, available)))]);
        _position += read;
        return read;
    }

    private async ValueTask<int> TryReadLocalAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken)
    {
        var cache = cacheAccessor();
        var available = cache is null ? 0 : cache.DownloadedBytes - _position;
        if (available <= 0 || buffer.Length == 0 || !EnsureLocal(cache!))
            return 0;
        _local!.Position = _position;
        var read = await _local.ReadAsync(
            buffer[..Math.Min(buffer.Length, checked((int)Math.Min(int.MaxValue, available)))],
            cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    private bool EnsureLocal(PreDownloadCacheFile cache)
    {
        if (ReferenceEquals(cache, _openedCache) && _local is not null)
            return true;
        _local?.Dispose();
        _local = cache.TryOpenReadablePrefix();
        _openedCache = _local is null ? null : cache;
        return _local is not null;
    }

    private bool IsCompletedLocalEof()
    {
        var cache = cacheAccessor();
        return cache is { IsComplete: true } && _position >= cache.TotalBytes;
    }

    private void AlignRemote()
    {
        if (remote.Position != _position)
            remote.Position = _position;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        var target = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => checked(_position + offset),
            SeekOrigin.End => checked(Length + offset),
            _ => throw new ArgumentOutOfRangeException(nameof(origin)),
        };
        if (target < 0)
            throw new IOException("Cannot seek before the beginning of the stream.");
        _position = target;
        return _position;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _local?.Dispose();
            remote.Dispose();
        }
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        if (_local is not null)
            await _local.DisposeAsync().ConfigureAwait(false);
        await remote.DisposeAsync().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    public override void Flush() => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    private static void ValidateBuffer(byte[] buffer, int offset, int count)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        ArgumentOutOfRangeException.ThrowIfNegative(offset);
        ArgumentOutOfRangeException.ThrowIfNegative(count);
        if (offset > buffer.Length - count)
            throw new ArgumentException("The buffer range is invalid.");
    }
}
