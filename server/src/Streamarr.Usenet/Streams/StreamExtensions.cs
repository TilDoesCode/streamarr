// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Extensions/StreamExtensions.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (dispose-callback helpers dropped).

using System.Buffers;

namespace Streamarr.Usenet.Streams;

public static class StreamExtensions
{
    public static Stream LimitLength(this Stream stream, long length)
    {
        return new LimitedLengthStream(stream, length);
    }

    public static async Task DiscardBytesAsync(this Stream stream, long count, CancellationToken ct = default)
    {
        if (count == 0) return;
        var remaining = count;
        var throwaway = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (remaining > 0)
            {
                var toRead = (int)Math.Min(remaining, throwaway.Length);
                var read = await stream.ReadAsync(throwaway.AsMemory(0, toRead), ct).ConfigureAwait(false);
                if (read == 0) break;
                remaining -= read;
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(throwaway);
        }
    }
}
