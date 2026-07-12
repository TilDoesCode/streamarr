using SharpCompress.Archives.Rar;
using SharpCompress.Readers;

namespace Streamarr.Usenet.Tests.Rar;

/// <summary>
/// Guards the hand-built RAR fixtures (see Fixtures/rar/generate_fixtures.py) by
/// extracting them with SharpCompress — an independent reader — and comparing
/// against the deterministic payload. If these fail, the fixtures are wrong, not
/// Streamarr's RAR code.
/// </summary>
public class RarFixtureSanityTests
{
    private static byte[] Extract(IRarArchive archive, string key)
    {
        var entry = archive.Entries.First(e => !e.IsDirectory && e.Key == key);
        using var stream = entry.OpenEntryStream();
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    [Theory]
    [InlineData("single-rar4.rar")]
    [InlineData("single-rar5.rar")]
    public void SingleVolumeFixtures_ExtractCorrectly_WithSharpCompress(string fixture)
    {
        using var archive = RarArchive.OpenArchive(RarFixtures.PathOf(fixture), new ReaderOptions());
        Assert.Equal(RarFixtures.Payload, Extract(archive, "payload.bin"));
        Assert.Equal(RarFixtures.Notes, Extract(archive, "notes.txt"));
    }

    [Fact]
    public void MultiVolumeRar4Fixture_ExtractsCorrectly_WithSharpCompress()
    {
        IReadOnlyList<Stream> parts = RarFixtures.MultiRar4Parts
            .Select(p => (Stream)File.OpenRead(RarFixtures.PathOf(p))).ToList();
        using var archive = RarArchive.OpenArchive(parts, new ReaderOptions());
        Assert.Equal(RarFixtures.Payload, Extract(archive, "payload.bin"));
    }

    [Fact]
    public void MultiVolumeRar5Fixture_ExtractsCorrectly_WithSharpCompress()
    {
        IReadOnlyList<Stream> parts = RarFixtures.MultiRar5Parts
            .Select(p => (Stream)File.OpenRead(RarFixtures.PathOf(p))).ToList();
        using var archive = RarArchive.OpenArchive(parts, new ReaderOptions());
        Assert.Equal(RarFixtures.Payload, Extract(archive, "payload.bin"));
    }
}
