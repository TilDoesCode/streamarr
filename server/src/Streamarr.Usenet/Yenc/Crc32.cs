namespace Streamarr.Usenet.Yenc;

/// <summary>
/// Standard CRC-32 (ISO-HDLC / zlib polynomial 0xEDB88320), as used by yEnc
/// <c>crc32</c>/<c>pcrc32</c> trailer attributes. Written for Streamarr.
/// </summary>
public static class Crc32
{
    private static readonly uint[] Table = BuildTable();

    private static uint[] BuildTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            var c = i;
            for (var k = 0; k < 8; k++)
                c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }

        return table;
    }

    public const uint InitialState = 0xFFFFFFFFu;

    /// <summary>Updates a running CRC state (pass <see cref="InitialState"/> to start).</summary>
    public static uint Update(uint state, ReadOnlySpan<byte> data)
    {
        foreach (var b in data)
            state = Table[(state ^ b) & 0xFF] ^ (state >> 8);
        return state;
    }

    /// <summary>Finalizes a running CRC state into the CRC-32 value.</summary>
    public static uint Finalize(uint state) => state ^ 0xFFFFFFFFu;

    public static uint Compute(ReadOnlySpan<byte> data) => Finalize(Update(InitialState, data));
}
