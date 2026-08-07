using System.Buffers.Binary;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Par2;

namespace Streamarr.Usenet.Tests.Par2;

public class Par2SetParserTests
{
    // ------------------------------------------------------------------ golden (par2cmdline 0.8.1)

    [Fact]
    public void GoldenIndex_ParsesTheRealPar2cmdlineLayout()
    {
        var set = Par2SetParser.Parse(Par2TestData.GoldenIndex());

        Assert.Equal(65536, set.SliceSize);
        var file = Assert.Single(set.Files);
        Assert.Equal("golden-source.bin", file.Description.FileName);
        Assert.Equal(1_060_921, file.Description.FileLength);
        Assert.Equal(17, file.SliceCount);
        Assert.Equal(17, set.TotalSlices);
        Assert.Equal(0, set.ForeignPackets);
        Assert.Equal(17, file.Checksums.Slices.Count);
    }

    [Fact]
    public void GoldenIndex_SliceChecksumsMatchTheActualFileContent()
    {
        var set = Par2SetParser.Parse(Par2TestData.GoldenIndex());
        var source = Par2TestData.GoldenSource();
        var file = set.Files[0];
        var padded = new byte[set.SliceSize];
        for (var i = 0; i < file.SliceCount; i++)
        {
            Array.Clear(padded);
            var take = (int)Math.Min(set.SliceSize, source.Length - i * set.SliceSize);
            source.AsSpan(i * (int)set.SliceSize, take).CopyTo(padded);
            Assert.Equal(System.Security.Cryptography.MD5.HashData(padded), file.Checksums.Slices[i].Md5);
            Assert.Equal(Streamarr.Usenet.Yenc.Crc32.Compute(padded), file.Checksums.Slices[i].Crc32);
        }
    }

    // ------------------------------------------------------------------ writer round-trip

    [Fact]
    public void WriterRoundTrip_MultipleFiles()
    {
        var files = new[]
        {
            ("b-file.bin", Par2TestData.DeterministicBytes(200_000, seed: 1)),
            ("a-file.bin", Par2TestData.DeterministicBytes(70_001, seed: 2)),
        };
        var testSet = Par2TestWriter.Create(files, sliceSize: 65536, recoverySliceCount: 4);

        var set = Par2SetParser.Parse(testSet.IndexBytes);

        Assert.Equal(65536, set.SliceSize);
        Assert.Equal(2, set.Files.Count);
        Assert.Equal(set.Files.Sum(f => (long)f.SliceCount), set.TotalSlices);
        Assert.All(set.Files, f => Assert.Contains(f.Description.FileName, new[] { "a-file.bin", "b-file.bin" }));
        Assert.Equal(0, set.Files[0].GlobalSliceOffset);
        Assert.Equal(set.Files[0].SliceCount, (int)set.Files[1].GlobalSliceOffset);
    }

    // ------------------------------------------------------------------ negative / bounds

    [Fact]
    public void NoValidMainPacket_Throws()
    {
        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(new byte[512]));
    }

    [Fact]
    public void CancelledParse_StopsBeforeScanningUntrustedInput()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.Throws<OperationCanceledException>(() =>
            Par2SetParser.Parse(new byte[1024 * 1024], cancellationToken: cts.Token));
    }

    [Fact]
    public void OverlappingInvalidPackets_AreRejectedByTheProportionalHashWorkBudget()
    {
        var bytes = new byte[64 * 1024];
        for (var position = 0; position + Par2PacketHeader.Size <= bytes.Length; position += 64)
        {
            Par2PacketHeader.Magic.CopyTo(bytes.AsSpan(position, 8));
            BinaryPrimitives.WriteUInt64LittleEndian(
                bytes.AsSpan(position + 8, 8),
                (ulong)(bytes.Length - position));
        }

        var error = Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(bytes));

        Assert.Contains("verification work", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CorruptedPacketMd5_IsSkipped_AndBrokenMainMeansFailure()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 1024, 2);
        var bytes = (byte[])testSet.IndexBytes.Clone();
        bytes[70] ^= 0xFF; // inside the Main packet body (first packet in the index)

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(bytes));
    }

    [Fact]
    public void CorruptedFileDescPacket_IsDetectedThroughMissingDescription()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 1024, 2);
        var bytes = (byte[])testSet.IndexBytes.Clone();
        // Main body: 12 + 16 = 28 -> main packet 92 bytes; FileDesc follows.
        bytes[92 + 80] ^= 0xFF;

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(bytes));
    }

    [Fact]
    public void ForeignSetPackets_AreIgnoredAndCounted()
    {
        var setA = Par2TestWriter.Create([("a.bin", Par2TestData.DeterministicBytes(5_000, 1))], 1024, 2);
        var setB = Par2TestWriter.Create([("b.bin", Par2TestData.DeterministicBytes(5_000, 2))], 1024, 2);
        var combined = setA.IndexBytes.Concat(setB.IndexBytes).ToArray();

        var parsed = Par2SetParser.Parse(combined);

        Assert.Equal("a.bin", parsed.Files.Single().Description.FileName);
        Assert.True(parsed.ForeignPackets > 0);
    }

    [Fact]
    public void ForeignNonMainBeforeTheIntendedMain_DoesNotChooseTheWrongSet()
    {
        var setA = Par2TestWriter.Create([("a.bin", Par2TestData.DeterministicBytes(5_000, 1))], 1024, 2);
        var setB = Par2TestWriter.Create([("b.bin", Par2TestData.DeterministicBytes(5_000, 2))], 1024, 2);
        var foreignDescription = ExtractPackets(setB.IndexBytes)
            .Single(packet => packet.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.FileDesc));
        var combined = foreignDescription.Concat(setA.IndexBytes).ToArray();

        var parsed = Par2SetParser.Parse(combined);

        Assert.Equal("a.bin", parsed.Files.Single().Description.FileName);
        Assert.Equal(1, parsed.ForeignPackets);
    }

    [Fact]
    public void CriticalPacketsBeforeMain_AreCollectedInASecondPass()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(5_000))], 1024, 2);
        var packets = ExtractPackets(testSet.IndexBytes);
        var main = packets.Single(packet => packet.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.Main));
        var reordered = packets.Where(packet => !ReferenceEquals(packet, main))
            .SelectMany(packet => packet)
            .Concat(main)
            .ToArray();

        var parsed = Par2SetParser.Parse(reordered);

        Assert.Equal("f.bin", parsed.Files.Single().Description.FileName);
    }

    [Fact]
    public void ConflictingDuplicateIfscPackets_Throw()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(5_000))], 1024, 2);
        var ifsc = ExtractPackets(testSet.IndexBytes)
            .Single(packet => packet.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.InputFileSliceChecksum));
        var conflictingBody = ifsc[64..];
        conflictingBody[16] ^= 0xff;
        var conflicting = Par2TestWriter.BuildPacket(
            testSet.SetId,
            Par2PacketTypes.InputFileSliceChecksum,
            conflictingBody);
        var combined = testSet.IndexBytes.Concat(conflicting).ToArray();

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(combined));
    }

    [Fact]
    public void IdenticalDuplicateIfscPackets_AreAccepted()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(5_000))], 1024, 2);
        var ifsc = ExtractPackets(testSet.IndexBytes)
            .Single(packet => packet.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.InputFileSliceChecksum));

        var parsed = Par2SetParser.Parse(testSet.IndexBytes.Concat(ifsc).ToArray());

        Assert.Single(parsed.Files);
    }

    [Fact]
    public void ConflictingMainPackets_SameSet_Throw()
    {
        var files = new[] { ("a.bin", Par2TestData.DeterministicBytes(5_000, 1)) };
        var setA = Par2TestWriter.Create(files, 1024, 2);
        var conflicting = Par2TestWriter.Create(files, 2048, 2);
        // Rewrite the conflicting Main's set id to match set A, with a fresh packet MD5.
        var mainB = ExtractFirstPacket(conflicting.IndexBytes);
        var forged = Par2TestWriter.BuildPacket(setA.SetId, Par2PacketTypes.Main, mainB[64..]);
        var combined = setA.IndexBytes.Concat(forged).ToArray();

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(combined));
    }

    [Fact]
    public void TruncatedTrailingPacket_IsIgnored()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 1024, 2);
        var truncated = testSet.IndexBytes[..^10];

        var parsed = Par2SetParser.Parse(truncated);

        Assert.Single(parsed.Files);
    }

    [Fact]
    public void GarbageBetweenPackets_ResyncsOnTheMagic()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 1024, 2);
        var garbage = new byte[137];
        new Random(9).NextBytes(garbage);
        var combined = garbage.Concat(testSet.IndexBytes).ToArray();

        var parsed = Par2SetParser.Parse(combined);

        Assert.Single(parsed.Files);
    }

    [Fact]
    public void SliceSizeBeyondLimit_Throws()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 65536, 2);

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(
            testSet.IndexBytes, new Par2ParserLimits { MaxSliceSize = 1024 }));
    }

    [Fact]
    public void FileNameBeyondLimit_Throws()
    {
        var testSet = Par2TestWriter.Create(
            [(new string('x', 200) + ".bin", Par2TestData.DeterministicBytes(4_000))], 1024, 2);

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(
            testSet.IndexBytes, new Par2ParserLimits { MaxFileNameBytes = 64 }));
    }

    [Fact]
    public void TotalSliceCountBeyondLimit_Throws()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(64 * 1024))], 1024, 2);

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(
            testSet.IndexBytes, new Par2ParserLimits { MaxTotalSlices = 8 }));
    }

    [Fact]
    public void IfscSliceCountMismatch_Throws()
    {
        var data = Par2TestData.DeterministicBytes(10_000);
        var good = Par2TestWriter.Create([("f.bin", data)], 1024, 2);
        // Rebuild the index, replacing the FileDesc length so IFSC (10 slices) no longer matches.
        var packets = ExtractPackets(good.IndexBytes);
        var fileDesc = packets.Single(p => p.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.FileDesc));
        var body = fileDesc[64..];
        BinaryPrimitives.WriteUInt64LittleEndian(body.AsSpan(48, 8), 25_000);
        var forged = Par2TestWriter.BuildPacket(good.SetId, Par2PacketTypes.FileDesc, body);
        var rebuilt = packets
            .Where(p => !p.AsSpan(48, 16).SequenceEqual(Par2PacketTypes.FileDesc))
            .SelectMany(p => p)
            .Concat(forged)
            .ToArray();

        Assert.Throws<Par2FormatException>(() => Par2SetParser.Parse(rebuilt));
    }

    // ------------------------------------------------------------------ range mapping

    [Theory]
    [InlineData(100, 200, new[] { 0 })]                 // hole inside one slice
    [InlineData(1000, 1100, new[] { 0, 1 })]            // hole across a slice boundary
    [InlineData(0, 1, new[] { 0 })]                     // first byte
    [InlineData(9_999, 10_000, new[] { 9 })]            // last (short) slice
    [InlineData(2048, 2048, new int[0])]                // empty range
    [InlineData(500, 5_000, new[] { 0, 1, 2, 3, 4 })]   // multi-slice damage
    public void SliceIndicesForRange_IsByteExact(long start, long end, int[] expected)
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(10_000))], 1024, 2);
        var set = Par2SetParser.Parse(testSet.IndexBytes);

        Assert.Equal(expected, set.SliceIndicesForRange(0, start, end).ToArray());
    }

    [Fact]
    public void SliceIndicesForRange_SecondFileUsesGlobalIndices()
    {
        var files = new[]
        {
            ("b-file.bin", Par2TestData.DeterministicBytes(4_096, 1)),
            ("a-file.bin", Par2TestData.DeterministicBytes(2_048, 2)),
        };
        var set = Par2SetParser.Parse(Par2TestWriter.Create(files, 1024, 2).IndexBytes);

        var offset = set.Files[1].GlobalSliceOffset;
        Assert.Equal([(int)offset, (int)offset + 1], set.SliceIndicesForRange(1, 0, 2_000).ToArray());
    }

    private static byte[] ExtractFirstPacket(byte[] bytes)
    {
        var length = (int)BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(8, 8));
        return bytes[..length];
    }

    private static List<byte[]> ExtractPackets(byte[] bytes)
    {
        var packets = new List<byte[]>();
        var pos = 0;
        while (pos + 64 <= bytes.Length)
        {
            var length = (int)BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(pos + 8, 8));
            packets.Add(bytes[pos..(pos + length)]);
            pos += length;
        }
        return packets;
    }
}
