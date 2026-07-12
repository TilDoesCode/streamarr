using System.Text;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Tests.Yenc;

public class YencStreamTests
{
    private static YencStream DecoderFor(string articleText, bool validateCrc = true) =>
        new(new MemoryStream(Encoding.Latin1.GetBytes(articleText)), validateCrc);

    private static async Task<byte[]> DecodeAll(YencStream stream)
    {
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);
        return ms.ToArray();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(127)]
    [InlineData(128)]
    [InlineData(129)]
    [InlineData(100_000)]
    public async Task RoundTrip_RandomData(int size)
    {
        var data = YencTestEncoder.LcgBytes(size, size);
        var article = YencTestEncoder.Encode(data, "file.bin");

        await using var decoder = DecoderFor(article);
        var decoded = await DecodeAll(decoder);

        Assert.Equal(data, decoded);
    }

    [Fact]
    public async Task RoundTrip_AllByteValues_CoversEveryEscapeSequence()
    {
        var data = new byte[1024];
        for (var i = 0; i < data.Length; i++) data[i] = (byte)(i % 256);
        var article = YencTestEncoder.Encode(data, "all-bytes.bin");

        // sanity: the encoding actually contains escape sequences
        Assert.Contains('=', article[article.IndexOf('\n')..article.IndexOf("=yend", StringComparison.Ordinal)]);

        await using var decoder = DecoderFor(article);
        Assert.Equal(data, await DecodeAll(decoder));
    }

    [Fact]
    public async Task RoundTrip_KnownVector()
    {
        // "Hello" shifts to bytes 72 8F 96 96 99 (no escapes); hand-checked vector.
        // CRC32("Hello") = 0xF7D18982.
        var article =
            "=ybegin line=128 size=5 name=hello.txt\r\n" +
            "r\u008F\u0096\u0096\u0099\r\n" +
            "=yend size=5 crc32=f7d18982\r\n";

        await using var decoder = DecoderFor(article);
        var decoded = await DecodeAll(decoder);

        Assert.Equal("Hello", Encoding.ASCII.GetString(decoded));
    }

    [Fact]
    public async Task Headers_SinglePart_AreParsed()
    {
        var data = YencTestEncoder.LcgBytes(3, 2000);
        var article = YencTestEncoder.Encode(data, "movie.mkv");

        await using var decoder = DecoderFor(article);
        var header = await decoder.GetYencHeadersAsync();

        Assert.NotNull(header);
        Assert.Equal("movie.mkv", header!.FileName);
        Assert.Equal(2000, header.FileSize);
        Assert.Equal(2000, header.PartSize);
        Assert.Equal(0, header.PartOffset);
        Assert.False(header.IsFilePart);
    }

    [Fact]
    public async Task Headers_MultiPart_ExposePartOffsetAndSize()
    {
        var whole = YencTestEncoder.LcgBytes(9, 5000);
        var article = YencTestEncoder.EncodePart(whole, "movie.mkv", partNumber: 2, totalParts: 3,
            begin: 2001, end: 4000);

        await using var decoder = DecoderFor(article);
        var header = await decoder.GetYencHeadersAsync();

        Assert.NotNull(header);
        Assert.Equal(2, header!.PartNumber);
        Assert.Equal(3, header.TotalParts);
        Assert.Equal(5000, header.FileSize);
        Assert.Equal(2000, header.PartOffset); // zero-based
        Assert.Equal(2000, header.PartSize);
        Assert.True(header.IsFilePart);

        var decoded = await DecodeAll(decoder);
        Assert.Equal(whole[2000..4000], decoded);
    }

    [Fact]
    public async Task CorruptData_FailsCrc32Validation()
    {
        var data = YencTestEncoder.LcgBytes(5, 4096);
        var article = YencTestEncoder.Encode(data, "file.bin");

        // flip one encoded data byte (avoid header/trailer lines and escape chars)
        var corrupted = new StringBuilder(article);
        var index = article.IndexOf('\n') + 10;
        corrupted[index] = corrupted[index] == 'A' ? 'B' : 'A';

        await using var decoder = DecoderFor(corrupted.ToString());
        await Assert.ThrowsAsync<YencCrcMismatchException>(async () => await DecodeAll(decoder));
    }

    [Fact]
    public async Task TruncatedData_FailsSizeValidation()
    {
        var data = YencTestEncoder.LcgBytes(6, 4096);
        var article = YencTestEncoder.Encode(data, "file.bin");

        // drop one full data line
        var lines = article.Split("\r\n").ToList();
        lines.RemoveAt(2);
        var truncated = string.Join("\r\n", lines);

        await using var decoder = DecoderFor(truncated);
        await Assert.ThrowsAsync<YencCrcMismatchException>(async () => await DecodeAll(decoder));
    }

    [Fact]
    public async Task CrcValidation_CanBeDisabled()
    {
        var data = YencTestEncoder.LcgBytes(6, 512);
        var article = YencTestEncoder.Encode(data, "file.bin")
            .Replace("crc32=", "crc32=00000000 x="); // break the crc attribute value

        await using var decoder = DecoderFor(article, validateCrc: false);
        Assert.Equal(data, await DecodeAll(decoder));
    }

    [Fact]
    public async Task MissingYbegin_Throws()
    {
        await using var decoder = DecoderFor("this is not yenc\r\n");
        await Assert.ThrowsAsync<InvalidDataException>(async () => await DecodeAll(decoder));
    }

    [Fact]
    public async Task SmallReads_AcrossLineBoundaries_Work()
    {
        var data = YencTestEncoder.LcgBytes(11, 3000);
        var article = YencTestEncoder.Encode(data, "file.bin");

        await using var decoder = DecoderFor(article);
        using var ms = new MemoryStream();
        var buffer = new byte[7]; // deliberately tiny, misaligned reads
        int read;
        while ((read = await decoder.ReadAsync(buffer)) > 0)
            ms.Write(buffer, 0, read);

        Assert.Equal(data, ms.ToArray());
    }
}
