using Streamarr.Usenet.Rar;

namespace Streamarr.Usenet.Tests.Rar;

public class RarRandomAccessTests
{
    private static async Task<(RarStoredFile File, string[] PartPaths)> IndexSet(string[] partNames)
    {
        var volumes = new List<RarVolume>();
        foreach (var name in partNames)
        {
            await using var stream = File.OpenRead(RarFixtures.PathOf(name));
            volumes.Add(await RarVolumeReader.ReadAsync(stream, name, CancellationToken.None));
        }

        var files = RarArchiveIndexer.Index(volumes);
        var payloadFile = files.Single(f => f.PathWithinArchive == "payload.bin");
        return (payloadFile, partNames.Select(RarFixtures.PathOf).ToArray());
    }

    private static RarStoredFileStream OpenStream(RarStoredFile file, string[] partPaths) =>
        new(file, (partIndex, _) => ValueTask.FromResult<Stream>(File.OpenRead(partPaths[partIndex])));

    public static TheoryData<string[]> MultiVolumeSets => new()
    {
        RarFixtures.MultiRar4Parts,
        RarFixtures.MultiRar5Parts,
    };

    [Theory]
    [MemberData(nameof(MultiVolumeSets))]
    public async Task Index_MapsSlicesAcrossAllVolumes(string[] parts)
    {
        var (file, _) = await IndexSet(parts);

        Assert.Equal(RarFixtures.Payload.Length, file.Size);
        Assert.Equal(3, file.Slices.Count);

        // slices tile the file contiguously
        Assert.Equal(0, file.Slices[0].ByteRangeWithinFile.StartInclusive);
        for (var i = 1; i < file.Slices.Count; i++)
        {
            Assert.Equal(file.Slices[i - 1].ByteRangeWithinFile.EndExclusive,
                file.Slices[i].ByteRangeWithinFile.StartInclusive);
            Assert.Equal(i, file.Slices[i].PartIndex);
        }

        Assert.Equal(file.Size, file.Slices[^1].ByteRangeWithinFile.EndExclusive);
    }

    [Theory]
    [MemberData(nameof(MultiVolumeSets))]
    public async Task Index_VolumesSuppliedOutOfOrder_AreSorted(string[] parts)
    {
        var shuffled = new[] { parts[2], parts[0], parts[1] };
        var (file, _) = await IndexSet(shuffled);

        // slice ordering must follow part numbers, not supply order
        var sizes = file.Slices.Select(s => s.ByteRangeWithinFile.Count).ToArray();
        Assert.Equal(RarFixtures.Payload.Length, sizes.Sum());
        Assert.Equal(file.Size, file.Slices[^1].ByteRangeWithinFile.EndExclusive);
    }

    [Theory]
    [MemberData(nameof(MultiVolumeSets))]
    public async Task FullRead_MatchesOriginalPayload(string[] parts)
    {
        var (file, paths) = await IndexSet(parts);

        await using var stream = OpenStream(file, paths);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(RarFixtures.Payload, ms.ToArray());
    }

    [Theory]
    [MemberData(nameof(MultiVolumeSets))]
    public async Task SeekAnywhere_IncludingAcrossVolumeBoundaries_ReadsCorrectBytes(string[] parts)
    {
        var (file, paths) = await IndexSet(parts);
        var payload = RarFixtures.Payload;

        // 32 KiB volumes: offsets probe within, at, and across volume boundaries
        long[] offsets = [0, 1, 32_767, 32_768, 32_769, 65_535, 65_536, 98_303, payload.Length - 1];

        await using var stream = OpenStream(file, paths);
        foreach (var offset in offsets)
        {
            stream.Seek(offset, SeekOrigin.Begin);
            var expectedLength = (int)Math.Min(4096, payload.Length - offset);
            var buffer = new byte[expectedLength];
            var read = 0;
            while (read < expectedLength)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read));
                if (n == 0) break;
                read += n;
            }

            Assert.Equal(expectedLength, read);
            Assert.Equal(payload[(int)offset..(int)(offset + expectedLength)], buffer);
        }
    }

    [Fact]
    public async Task SingleVolume_RandomAccessStream_Works()
    {
        var (file, paths) = await IndexSet(["single-rar5.rar"]);

        await using var stream = OpenStream(file, paths);
        stream.Seek(12_345, SeekOrigin.Begin);
        var buffer = new byte[100];
        var read = 0;
        while (read < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read));
            if (n == 0) break;
            read += n;
        }

        Assert.Equal(RarFixtures.Payload[12_345..12_445], buffer);
    }

    [Fact]
    public async Task Index_MissingVolume_ThrowsIncompleteSet()
    {
        var volumes = new List<RarVolume>();
        foreach (var name in new[] { RarFixtures.MultiRar5Parts[0], RarFixtures.MultiRar5Parts[2] })
        {
            await using var stream = File.OpenRead(RarFixtures.PathOf(name));
            volumes.Add(await RarVolumeReader.ReadAsync(stream, name, CancellationToken.None));
        }

        Assert.Throws<InvalidDataException>(() => RarArchiveIndexer.Index(volumes));
    }

    [Fact]
    public async Task ReadPastEnd_ReturnsZero()
    {
        var (file, paths) = await IndexSet(["single-rar4.rar"]);
        await using var stream = OpenStream(file, paths);
        stream.Seek(0, SeekOrigin.End);
        Assert.Equal(0, await stream.ReadAsync(new byte[8].AsMemory()));
    }

    [Fact]
    public void Index_RejectsExcessiveOrDuplicateVolumeSetsBeforeBuildingSlices()
    {
        RarVolume Volume(int part) => new()
        {
            FileName = $"part{part}.rar",
            PartSize = 1,
            IsRar5 = true,
            PartNumberFromFilename = part,
            PartNumberFromHeader = null,
            Slices = [],
        };

        Assert.Throws<InvalidDataException>(() =>
            RarArchiveIndexer.Index(Enumerable.Range(0, RarArchiveIndexer.MaxVolumes + 1).Select(Volume)));
        Assert.Throws<InvalidDataException>(() => RarArchiveIndexer.Index([Volume(1), Volume(1)]));
    }
}
