using Streamarr.Tests.Shared;
using Streamarr.Usenet.Rar;

namespace Streamarr.Usenet.Tests.Rar;

/// <summary>
/// Sanity checks for the in-memory RAR4 writer used by the streaming integration
/// tests: its output must be readable by our own RAR reader stack and reassemble
/// to the original payload byte-for-byte.
/// </summary>
public class Rar4TestWriterTests
{
    private static readonly byte[] Payload = YencTestEncoder.LcgBytes(7, 200_000);

    [Fact]
    public async Task MultiVolume_RoundTrips_ThroughRarReaderStack()
    {
        var volumes = Rar4TestWriter.WriteMultiVolume("movie", "movie.mkv", Payload, chunkSize: 70_000);
        Assert.Equal(3, volumes.Count);
        Assert.Equal(["movie.rar", "movie.r00", "movie.r01"], volumes.Select(v => v.FileName));

        var parsed = new List<RarVolume>();
        foreach (var (fileName, bytes) in volumes)
        {
            using var stream = new MemoryStream(bytes);
            parsed.Add(await RarVolumeReader.ReadAsync(stream, fileName, CancellationToken.None));
        }

        var indexed = RarArchiveIndexer.Index(parsed);
        var file = Assert.Single(indexed);
        Assert.Equal("movie.mkv", file.PathWithinArchive);
        Assert.Equal(Payload.Length, file.Size);

        await using var reassembled = new RarStoredFileStream(
            file,
            (partIndex, _) => new ValueTask<Stream>(new MemoryStream(volumes[partIndex].Bytes)));
        using var ms = new MemoryStream();
        await reassembled.CopyToAsync(ms);
        Assert.Equal(Payload, ms.ToArray());
    }

    [Fact]
    public async Task SingleVolume_ContainsAllEntries()
    {
        var notes = "notes"u8.ToArray();
        var archive = Rar4TestWriter.WriteSingleVolume(("payload.bin", Payload), ("notes.txt", notes));

        using var stream = new MemoryStream(archive);
        var volume = await RarVolumeReader.ReadAsync(stream, "single.rar", CancellationToken.None);
        var indexed = RarArchiveIndexer.Index([volume]);

        Assert.Equal(2, indexed.Count);
        Assert.Equal(Payload.Length, indexed.Single(f => f.PathWithinArchive == "payload.bin").Size);
        Assert.Equal(notes.Length, indexed.Single(f => f.PathWithinArchive == "notes.txt").Size);
    }
}
