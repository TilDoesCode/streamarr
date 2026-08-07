using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Par2;

namespace Streamarr.Usenet.Tests.Par2;

public class Par2VolumeScannerTests
{
    [Fact]
    public void GoldenVolumes_FullyCovered_YieldAllVerifiedSlices()
    {
        var set = Par2SetParser.Parse(Par2TestData.GoldenIndex());

        var vol0 = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(Par2TestData.GoldenVolume(0)), set.SetId, set.SliceSize);
        var vol2 = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(Par2TestData.GoldenVolume(2)), set.SetId, set.SliceSize);

        Assert.Equal([0u, 1u], vol0.Select(s => s.Exponent));
        Assert.Equal([2u, 3u], vol2.Select(s => s.Exponent));
        Assert.All(vol0.Concat(vol2), s =>
        {
            Assert.True(s.Verified);
            Assert.Equal(set.SliceSize, s.DataLength);
        });
    }

    [Fact]
    public void HoleOverlappingOneSlice_OnlyTheOtherSurvives()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(300_000))], 4096, 4, recoverySlicesPerVolume: 4);
        var volume = testSet.Volumes[0].Bytes;
        var set = Par2SetParser.Parse(testSet.IndexBytes);

        // Locate the recovery packets so the hole can be placed inside the second one.
        var full = Par2VolumeScanner.ScanRecoverySlices(new MemoryScanSource(volume), set.SetId, set.SliceSize);
        Assert.Equal(4, full.Count);
        var second = full[1];
        var covered = new List<LongRange>
        {
            new(0, second.DataOffset + 100),
            new(second.DataOffset + 700, volume.Length),
        };

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(volume, covered), set.SetId, set.SliceSize);

        Assert.Equal([0u, 2u, 3u], scanned.Select(s => s.Exponent));
        Assert.All(scanned, s => Assert.True(s.Verified));
    }

    [Fact]
    public void CorruptSliceData_FailsMd5AndIsDropped()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 2);
        var volume = (byte[])testSet.Volumes[0].Bytes.Clone();
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var slices = Par2VolumeScanner.ScanRecoverySlices(new MemoryScanSource(volume), set.SetId, set.SliceSize);
        volume[slices[0].DataOffset + 17] ^= 0xFF;

        var scanned = Par2VolumeScanner.ScanRecoverySlices(new MemoryScanSource(volume), set.SetId, set.SliceSize);

        Assert.Equal([slices[1].Exponent], scanned.Select(s => s.Exponent));
    }

    [Fact]
    public void ForeignSetId_IsIgnored()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 2);
        var otherSetId = new byte[16];
        otherSetId[3] = 0xAB;

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(testSet.Volumes[0].Bytes), otherSetId, 4096);

        Assert.Empty(scanned);
    }

    [Fact]
    public void MismatchedSliceSize_IsRejected()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 2);

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(testSet.Volumes[0].Bytes), testSet.SetId, expectedSliceSize: 8192);

        Assert.Empty(scanned);
    }

    [Fact]
    public void DuplicateExponentsAcrossVolumes_AreDeduplicated()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 2);
        var doubled = testSet.Volumes[0].Bytes.Concat(testSet.Volumes[0].Bytes).ToArray();

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(doubled), testSet.SetId, 4096);

        Assert.Equal([0u, 1u], scanned.Select(s => s.Exponent));
    }

    [Fact]
    public void UnalignedRangeAfterHole_ResyncsToLaterPacketsWithBoundedReads()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))],
            256 * 1024,
            3,
            recoverySlicesPerVolume: 3);
        var volume = testSet.Volumes[0].Bytes;
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var full = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(volume), set.SetId, set.SliceSize);
        var second = full[1];
        var covered = new List<LongRange>
        {
            new(0, second.DataOffset + 100),
            new(second.DataOffset + 701, volume.Length),
        };
        var source = new MemoryScanSource(volume, covered);

        var scanned = Par2VolumeScanner.ScanRecoverySlices(source, set.SetId, set.SliceSize);

        Assert.Equal([0u, 2u], scanned.Select(s => s.Exponent));
        Assert.True(source.ReadCount < 100, $"scanner made {source.ReadCount} random reads");
    }

    [Fact]
    public void UnverifiedForeignLength_CannotHideValidRecoveryPackets()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 2);
        var volume = testSet.Volumes[0].Bytes;
        var prefix = new byte[Par2PacketHeader.Size];
        Par2PacketHeader.Magic.CopyTo(prefix);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt64LittleEndian(
            prefix.AsSpan(8, 8),
            (ulong)(prefix.Length + volume.Length));
        prefix[32] = 0x7f;
        var combined = prefix.Concat(volume).ToArray();

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(combined), testSet.SetId, 4096);

        Assert.Equal([0u, 1u], scanned.Select(s => s.Exponent));
    }

    [Fact]
    public void FullUintRecoveryExponent_IsAccepted()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))],
            4096,
            1,
            firstExponent: uint.MaxValue);

        var scanned = Par2VolumeScanner.ScanRecoverySlices(
            new MemoryScanSource(testSet.Volumes[0].Bytes), testSet.SetId, 4096);

        Assert.Equal([uint.MaxValue], scanned.Select(s => s.Exponent));
    }
}
