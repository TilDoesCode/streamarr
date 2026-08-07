using Streamarr.Tests.Shared;
using Streamarr.Usenet.Par2;

namespace Streamarr.Usenet.Tests.Par2;

public class Par2RecoveryEngineTests
{
    // ---------------------------------------------------------------- golden cross-validation

    /// <summary>
    /// The decisive correctness test: recovery data produced by par2cmdline 0.8.1 must
    /// reconstruct byte-identical slices through our GF(2^16) implementation. This pins
    /// input constants, exponent semantics and word order against the reference tool.
    /// </summary>
    [Theory]
    [InlineData(new[] { 4 }, new[] { 0u })]
    [InlineData(new[] { 4, 5 }, new[] { 1u, 3u })]          // boundary-crossing damage, arbitrary slices
    [InlineData(new[] { 0, 8, 16 }, new[] { 0u, 1u, 2u })]  // first + middle + short last slice
    [InlineData(new[] { 13, 14, 15, 16 }, new[] { 0u, 1u, 2u, 3u })]
    public async Task GoldenSet_ReconstructsByteIdenticalSlices(int[] missing, uint[] exponents)
    {
        var set = Par2SetParser.Parse(Par2TestData.GoldenIndex());
        var source = Par2TestData.GoldenSource();
        var recovery = ScanGoldenRecovery(set);
        var io = new MemoryBlockIo(set, [source], recovery);

        await Par2RecoveryEngine.ReconstructAsync(set, missing, exponents, io);

        foreach (var index in missing)
        {
            var expected = new byte[set.SliceSize];
            var offset = index * set.SliceSize;
            var take = (int)Math.Min(set.SliceSize, source.Length - offset);
            source.AsSpan((int)offset, take).CopyTo(expected);
            Assert.Equal(expected, io.RecoveredSlices[index]);
        }
    }

    [Fact]
    public async Task GoldenSet_RepairedSlicesPassTheIfscChecksums()
    {
        var set = Par2SetParser.Parse(Par2TestData.GoldenIndex());
        var source = Par2TestData.GoldenSource();
        var io = new MemoryBlockIo(set, [source], ScanGoldenRecovery(set));

        await Par2RecoveryEngine.ReconstructAsync(set, [3, 9], [2u, 3u], io);

        var checksums = set.Files[0].Checksums;
        Assert.Equal(checksums.Slices[3].Md5, System.Security.Cryptography.MD5.HashData(io.RecoveredSlices[3]));
        Assert.Equal(checksums.Slices[9].Crc32, Streamarr.Usenet.Yenc.Crc32.Compute(io.RecoveredSlices[9]));
    }

    // ---------------------------------------------------------------- writer-based scenarios

    [Fact]
    public async Task MultiFileSet_RepairsDamageInBothFiles()
    {
        var files = new[]
        {
            ("bb.bin", Par2TestData.DeterministicBytes(150_000, 1)),
            ("aa.bin", Par2TestData.DeterministicBytes(66_000, 2)),
        };
        var testSet = Par2TestWriter.Create(files, 16_384, 4);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var ordered = set.Files
            .Select(f => files.Single(x => x.Item1 == f.Description.FileName).Item2)
            .ToList();
        var recovery = ScanVolumes(testSet, set);
        var io = new MemoryBlockIo(set, ordered, recovery);
        var lastOfFirstFile = set.Files[0].SliceCount - 1;
        var firstOfSecondFile = (int)set.Files[1].GlobalSliceOffset;
        int[] missing = [lastOfFirstFile, firstOfSecondFile];

        await Par2RecoveryEngine.ReconstructAsync(set, missing, [0u, 1u], io);

        foreach (var index in missing)
        {
            var (fileIndex, offset) = LocateSlice(set, index);
            var expected = new byte[set.SliceSize];
            var data = ordered[fileIndex];
            var take = (int)Math.Min(set.SliceSize, data.Length - offset);
            data.AsSpan((int)offset, take).CopyTo(expected);
            Assert.Equal(expected, io.RecoveredSlices[index]);
        }
    }

    [Fact]
    public async Task NotEnoughRecoverySlices_Throws()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(100_000))], 4096, 1);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [Par2TestData.DeterministicBytes(100_000)], ScanVolumes(testSet, set));

        await Assert.ThrowsAsync<Par2FormatException>(
            () => Par2RecoveryEngine.ReconstructAsync(set, [1, 2], [0u], io));
    }

    [Fact]
    public async Task NoMissingSlices_IsANoOp()
    {
        var testSet = Par2TestWriter.Create(
            [("f.bin", Par2TestData.DeterministicBytes(50_000))], 4096, 2);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [Par2TestData.DeterministicBytes(50_000)], []);

        await Par2RecoveryEngine.ReconstructAsync(set, [], [], io);

        Assert.Empty(io.RecoveredSlices);
    }

    [Fact]
    public async Task Cancellation_PropagatesPromptly()
    {
        var data = Par2TestData.DeterministicBytes(500_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 2);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [data], ScanVolumes(testSet, set));
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Par2RecoveryEngine.ReconstructAsync(set, [1], [0u], io, ct: cts.Token));
    }

    [Fact]
    public async Task Progress_ReportsMonotonicallyUpToTotal()
    {
        var data = Par2TestData.DeterministicBytes(200_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 2);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [data], ScanVolumes(testSet, set));
        var reports = new List<Par2ReconstructionProgress>();

        await Par2RecoveryEngine.ReconstructAsync(
            set, [7], [1u], io,
            new SynchronousProgress<Par2ReconstructionProgress>(reports.Add));

        Assert.NotEmpty(reports);
        Assert.Equal(reports.OrderBy(r => r.ProcessedBytes).Select(r => r.ProcessedBytes), reports.Select(r => r.ProcessedBytes));
        Assert.Equal(reports[^1].TotalBytes, reports[^1].ProcessedBytes);
    }

    [Fact]
    public async Task SingularLowestExponents_UsesALaterIndependentRecoverySlice()
    {
        var data = Par2TestData.DeterministicBytes(12_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 1);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        uint[] candidates = [0, 21_845, 21_846];
        var recovery = candidates.ToDictionary(
            exponent => exponent,
            exponent => Par2TestWriter.ComputeRecoverySlices([data], 4096, 1, exponent).Single().Data);
        var io = new MemoryBlockIo(set, [data], recovery);

        Assert.True(ReedSolomon16.TrySelectIndependentRecoveryExponents(
            [0, 2], candidates, out var selected));
        Assert.Equal([0u, 21_846u], selected);
        await Par2RecoveryEngine.ReconstructAsync(set, [0, 2], candidates, io);

        foreach (var index in new[] { 0, 2 })
        {
            var expected = new byte[set.SliceSize];
            var offset = index * (int)set.SliceSize;
            data.AsSpan(offset, Math.Min((int)set.SliceSize, data.Length - offset)).CopyTo(expected);
            Assert.Equal(expected, io.RecoveredSlices[index]);
        }
    }

    [Fact]
    public async Task FullUintRecoveryExponent_IsSupported()
    {
        var data = Par2TestData.DeterministicBytes(12_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 1);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var recovery = new Dictionary<uint, byte[]>
        {
            [uint.MaxValue] = ComputeRecoverySlice(set, [data], uint.MaxValue),
        };
        var io = new MemoryBlockIo(set, [data], recovery);

        await Par2RecoveryEngine.ReconstructAsync(set, [1], [uint.MaxValue], io);

        Assert.Equal(data.AsSpan(4096, 4096).ToArray(), io.RecoveredSlices[1]);
    }

    [Fact]
    public async Task DamagedSliceLimit_IsCheckedBeforeBlockIo()
    {
        var data = Par2TestData.DeterministicBytes(12_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 2);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [data], ScanVolumes(testSet, set));
        var limits = new Par2RecoveryLimits { MaxDamagedSlices = 1 };

        await Assert.ThrowsAsync<Par2RecoveryLimitException>(() =>
            Par2RecoveryEngine.ReconstructAsync(set, [0, 1], [0u, 1u], io, limits: limits));

        Assert.Empty(io.RecoveredSlices);
    }

    [Fact]
    public async Task AggregateWorkingMemoryLimit_IsCheckedBeforeAllocation()
    {
        var data = Par2TestData.DeterministicBytes(12_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 1);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [data], ScanVolumes(testSet, set));
        var limits = new Par2RecoveryLimits { MaxWorkingMemoryBytes = 1024 };

        await Assert.ThrowsAsync<Par2RecoveryLimitException>(() =>
            Par2RecoveryEngine.ReconstructAsync(set, [0], [0u], io, limits: limits));

        Assert.Empty(io.RecoveredSlices);
    }

    [Fact]
    public async Task AggregateReconstructionWorkLimit_IsCheckedBeforeBlockIo()
    {
        var data = Par2TestData.DeterministicBytes(12_000);
        var testSet = Par2TestWriter.Create([("f.bin", data)], 4096, 1);
        var set = Par2SetParser.Parse(testSet.IndexBytes);
        var io = new MemoryBlockIo(set, [data], ScanVolumes(testSet, set));
        var limits = new Par2RecoveryLimits { MaxReconstructionOperations = 1 };

        await Assert.ThrowsAsync<Par2RecoveryLimitException>(() =>
            Par2RecoveryEngine.ReconstructAsync(set, [0], [0u], io, limits: limits));

        Assert.Empty(io.RecoveredSlices);
    }

    [Fact]
    public void MatrixSolve_ObservesCancellationDuringCpuWork()
    {
        var missing = Enumerable.Range(0, 256).ToArray();
        var exponents = Enumerable.Range(0, 256).Select(i => (uint)i).ToArray();
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1));

        Assert.ThrowsAny<OperationCanceledException>(
            () => ReedSolomon16.InvertRecoveryMatrix(missing, exponents, cts.Token));
    }

    private static byte[] ComputeRecoverySlice(
        Par2SetInfo set,
        IReadOnlyList<byte[]> files,
        uint exponent)
    {
        var recovery = new byte[set.SliceSize];
        var input = new byte[set.SliceSize];
        var globalIndex = 0;
        foreach (var data in files)
        {
            for (var offset = 0; offset < data.Length; offset += (int)set.SliceSize, globalIndex++)
            {
                Array.Clear(input);
                data.AsSpan(offset, Math.Min(input.Length, data.Length - offset)).CopyTo(input);
                var factor = GaloisField16.Pow(GaloisField16.InputConstant(globalIndex), exponent);
                ReedSolomon16.MultiplyAccumulate(input, recovery, factor);
            }
        }
        return recovery;
    }

    private static Dictionary<uint, byte[]> ScanGoldenRecovery(Par2SetInfo set)
    {
        var recovery = new Dictionary<uint, byte[]>();
        foreach (var first in new[] { 0, 2 })
        {
            var volume = Par2TestData.GoldenVolume(first);
            foreach (var slice in Par2VolumeScanner.ScanRecoverySlices(new MemoryScanSource(volume), set.SetId, set.SliceSize))
                recovery[slice.Exponent] = volume[(int)slice.DataOffset..(int)(slice.DataOffset + slice.DataLength)];
        }
        return recovery;
    }

    private static Dictionary<uint, byte[]> ScanVolumes(Par2TestSet testSet, Par2SetInfo set)
    {
        var recovery = new Dictionary<uint, byte[]>();
        foreach (var (_, bytes) in testSet.Volumes)
        {
            foreach (var slice in Par2VolumeScanner.ScanRecoverySlices(new MemoryScanSource(bytes), set.SetId, set.SliceSize))
                recovery[slice.Exponent] = bytes[(int)slice.DataOffset..(int)(slice.DataOffset + slice.DataLength)];
        }
        return recovery;
    }

    private static (int FileIndex, long Offset) LocateSlice(Par2SetInfo set, int globalIndex)
    {
        for (var i = 0; i < set.Files.Count; i++)
        {
            var file = set.Files[i];
            if (globalIndex < file.GlobalSliceOffset + file.SliceCount)
                return (i, (globalIndex - file.GlobalSliceOffset) * set.SliceSize);
        }
        throw new ArgumentOutOfRangeException(nameof(globalIndex));
    }

    private sealed class SynchronousProgress<T>(Action<T> callback) : IProgress<T>
    {
        public void Report(T value) => callback(value);
    }
}
