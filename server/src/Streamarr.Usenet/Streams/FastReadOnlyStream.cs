// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Streams/{FastReadOnlyStream,FastReadOnlyNonSeekableStream}.cs
//         @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr (consolidated).

using System.Buffers;

namespace Streamarr.Usenet.Streams;

/// <summary>
/// Abstract base class for high-performance read-only streams.
/// Only requires implementing ReadAsync(Memory&lt;byte&gt;, CancellationToken).
/// All other read operations call into this async method.
/// </summary>
public abstract class FastReadOnlyStream : ReadOnlyStream
{
    // Core method - must be implemented by derived classes
    public abstract override ValueTask<int> ReadAsync(Memory<byte> buffer,
        CancellationToken cancellationToken = default);

    // All other read methods call into ReadAsync
    public override int Read(byte[] buffer, int offset, int count)
    {
        return ReadAsync(new Memory<byte>(buffer, offset, count), CancellationToken.None)
            .AsTask().GetAwaiter().GetResult();
    }

    public override int Read(Span<byte> buffer)
    {
        var rentedArray = ArrayPool<byte>.Shared.Rent(buffer.Length);
        try
        {
            var memory = new Memory<byte>(rentedArray, 0, buffer.Length);
            var bytesRead = ReadAsync(memory, CancellationToken.None)
                .AsTask().GetAwaiter().GetResult();
            memory.Span.Slice(0, bytesRead).CopyTo(buffer);
            return bytesRead;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rentedArray);
        }
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        return ReadAsync(new Memory<byte>(buffer, offset, count), cancellationToken).AsTask();
    }

    public override int ReadByte()
    {
        Span<byte> buffer = stackalloc byte[1];
        var bytesRead = Read(buffer);
        return bytesRead == 0 ? -1 : buffer[0];
    }
}

public abstract class FastReadOnlyNonSeekableStream : FastReadOnlyStream
{
    public override bool CanSeek => false;

    public override long Length => throw new NotSupportedException("This stream does not support seeking.");

    public override long Position
    {
        get => throw new NotSupportedException("This stream does not support seeking.");
        set => throw new NotSupportedException("This stream does not support seeking.");
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        throw new NotSupportedException("This stream does not support seeking.");
    }
}
