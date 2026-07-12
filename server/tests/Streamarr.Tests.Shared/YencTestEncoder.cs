using System.Text;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Tests.Shared;

/// <summary>
/// Test-side yEnc encoder used to produce round-trip vectors and mock articles.
/// Escapes the critical byte set ({NUL, LF, CR, '='}) per the yEnc 1.3 spec.
/// </summary>
public static class YencTestEncoder
{
    /// <summary>Encodes a whole file as a single-part yEnc article (with crc32 trailer).</summary>
    public static string Encode(byte[] data, string name, int lineLength = 128)
    {
        var sb = new StringBuilder();
        sb.Append($"=ybegin line={lineLength} size={data.Length} name={name}\r\n");
        AppendEncodedData(sb, data, lineLength);
        sb.Append($"=yend size={data.Length} crc32={Crc32.Compute(data):x8}\r\n");
        return sb.ToString();
    }

    /// <summary>
    /// Encodes one part of a multi-part file (1-based <paramref name="begin"/> /
    /// <paramref name="end"/> offsets, pcrc32 trailer), like Usenet posters do.
    /// </summary>
    public static string EncodePart(
        byte[] wholeFile, string name, int partNumber, int totalParts,
        long begin, long end, int lineLength = 128)
    {
        var part = wholeFile[(int)(begin - 1)..(int)end];
        var sb = new StringBuilder();
        sb.Append($"=ybegin part={partNumber} total={totalParts} line={lineLength} size={wholeFile.Length} name={name}\r\n");
        sb.Append($"=ypart begin={begin} end={end}\r\n");
        AppendEncodedData(sb, part, lineLength);
        sb.Append($"=yend size={part.Length} part={partNumber} pcrc32={Crc32.Compute(part):x8}\r\n");
        return sb.ToString();
    }

    private static void AppendEncodedData(StringBuilder sb, byte[] data, int lineLength)
    {
        var column = 0;
        foreach (var b in data)
        {
            var encoded = unchecked((byte)(b + 42));
            var escape = encoded is 0x00 or 0x0A or 0x0D or 0x3D; // NUL LF CR '='
            if (escape)
            {
                sb.Append('=');
                sb.Append((char)unchecked((byte)(encoded + 64)));
                column += 2;
            }
            else
            {
                sb.Append((char)encoded);
                column += 1;
            }

            if (column >= lineLength)
            {
                sb.Append("\r\n");
                column = 0;
            }
        }

        if (column > 0)
            sb.Append("\r\n");
    }

    /// <summary>Deterministic pseudo-random bytes (same LCG as the RAR fixture generator).</summary>
    public static byte[] LcgBytes(int seed, int count)
    {
        var output = new byte[count];
        long x = seed;
        for (var i = 0; i < count; i++)
        {
            x = (1103515245 * x + 12345) % (1L << 31);
            output[i] = (byte)(x & 0xFF);
        }

        return output;
    }
}
