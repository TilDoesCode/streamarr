using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Rar;

namespace Streamarr.Usenet.Tests.Rar;

public class RarVolumeReaderTests
{
    private static async Task<RarVolume> ReadVolume(string fixture)
    {
        await using var stream = File.OpenRead(RarFixtures.PathOf(fixture));
        return await RarVolumeReader.ReadAsync(stream, fixture, CancellationToken.None);
    }

    [Theory]
    [InlineData("single-rar4.rar", false)]
    [InlineData("single-rar5.rar", true)]
    public async Task HeaderWalk_FindsStoredEntries(string fixture, bool isRar5)
    {
        var volume = await ReadVolume(fixture);

        Assert.Equal(isRar5, volume.IsRar5);
        Assert.Equal(2, volume.Slices.Count);
        Assert.Equal(["payload.bin", "notes.txt"], volume.Slices.Select(s => s.PathWithinArchive));

        var payloadSlice = volume.Slices[0];
        Assert.Equal(RarFixtures.Payload.Length, payloadSlice.FileUncompressedSize);
        Assert.Equal(RarFixtures.Payload.Length, payloadSlice.ByteRangeWithinPart.Count);
        Assert.False(payloadSlice.IsSplitBefore);
        Assert.False(payloadSlice.IsSplitAfter);
    }

    [Theory]
    [InlineData("single-rar4.rar")]
    [InlineData("single-rar5.rar")]
    public async Task OffsetMapping_SlicesOutExactStoredBytes(string fixture)
    {
        var volume = await ReadVolume(fixture);
        var raw = await File.ReadAllBytesAsync(RarFixtures.PathOf(fixture));

        var payloadSlice = volume.Slices.Single(s => s.PathWithinArchive == "payload.bin");
        var start = (int)payloadSlice.ByteRangeWithinPart.StartInclusive;
        var end = (int)payloadSlice.ByteRangeWithinPart.EndExclusive;
        Assert.Equal(RarFixtures.Payload, raw[start..end]);

        var notesSlice = volume.Slices.Single(s => s.PathWithinArchive == "notes.txt");
        start = (int)notesSlice.ByteRangeWithinPart.StartInclusive;
        end = (int)notesSlice.ByteRangeWithinPart.EndExclusive;
        Assert.Equal(RarFixtures.Notes, raw[start..end]);
    }

    [Theory]
    [InlineData("compressed-rar4.rar")]
    [InlineData("compressed-rar5.rar")]
    public async Task CompressedEntries_AreRejected(string fixture)
    {
        await Assert.ThrowsAsync<UnsupportedRarCompressionMethodException>(() => ReadVolume(fixture));
    }

    [Theory]
    [InlineData("movie.part1.rar", 1)]
    [InlineData("movie.part017.rar", 17)]
    [InlineData("movie.rar", -1)]
    [InlineData("movie.r00", 0)]
    [InlineData("movie.r49", 49)]
    [InlineData("MOVIE.R01", 1)]
    public void PartNumberFromFilename_HandlesAllNamingSchemes(string filename, int expected)
    {
        Assert.Equal(expected, RarVolumeReader.GetPartNumberFromFilename(filename));
    }

    [Fact]
    public void PartNumberFromFilename_UnknownScheme_ReturnsNull()
    {
        Assert.Null(RarVolumeReader.GetPartNumberFromFilename("movie.mkv"));
    }

    [Theory]
    [InlineData("movie.part1.rar", "movie")]
    [InlineData("archive.rar", "archive")]
    public void GetArchiveName_StripsPartSuffixAndExtension(string filename, string expected)
    {
        Assert.Equal(expected, RarVolumeReader.GetArchiveName(filename));
    }

    [Fact]
    public async Task MultiVolume_SplitFlags_AreExposed()
    {
        var first = await ReadVolume("multi-rar4.rar");
        var middle = await ReadVolume("multi-rar4.r00");
        var last = await ReadVolume("multi-rar4.r01");

        Assert.False(first.Slices[0].IsSplitBefore);
        Assert.True(first.Slices[0].IsSplitAfter);
        Assert.True(middle.Slices[0].IsSplitBefore);
        Assert.True(middle.Slices[0].IsSplitAfter);
        Assert.True(last.Slices[0].IsSplitBefore);
        Assert.False(last.Slices[0].IsSplitAfter);
    }
}
