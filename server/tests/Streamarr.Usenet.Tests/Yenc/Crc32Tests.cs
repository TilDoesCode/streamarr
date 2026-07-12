using System.Text;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Tests.Yenc;

public class Crc32Tests
{
    [Fact]
    public void Compute_MatchesStandardCheckValue()
    {
        // The canonical CRC-32 (ISO-HDLC) check value.
        var crc = Crc32.Compute(Encoding.ASCII.GetBytes("123456789"));
        Assert.Equal(0xCBF43926u, crc);
    }

    [Fact]
    public void Compute_EmptyInput_IsZero()
    {
        Assert.Equal(0u, Crc32.Compute(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void Compute_KnownAsciiVector()
    {
        // CRC32("The quick brown fox jumps over the lazy dog") = 0x414FA339
        var crc = Crc32.Compute(Encoding.ASCII.GetBytes("The quick brown fox jumps over the lazy dog"));
        Assert.Equal(0x414FA339u, crc);
    }

    [Fact]
    public void IncrementalUpdate_MatchesOneShot()
    {
        var data = YencTestEncoder.LcgBytes(7, 10_000);

        var state = Crc32.InitialState;
        foreach (var chunk in data.Chunk(97))
            state = Crc32.Update(state, chunk);

        Assert.Equal(Crc32.Compute(data), Crc32.Finalize(state));
    }
}
