using Streamarr.Usenet.Models;
using Streamarr.Usenet.Par2;

namespace Streamarr.Usenet.Tests.Par2;

/// <summary>Shared helpers for the PAR2 test suite.</summary>
public static class Par2TestData
{
    public static string FixturePath(string name)
        => Path.Combine(AppContext.BaseDirectory, "Fixtures", "par2", name);

    public static byte[] GoldenSource() => File.ReadAllBytes(FixturePath("golden-source.bin"));
    public static byte[] GoldenIndex() => File.ReadAllBytes(FixturePath("golden.par2"));
    public static byte[] GoldenVolume(int first) => File.ReadAllBytes(FixturePath($"golden.vol{first}+2.par2"));

    public static byte[] DeterministicBytes(int count, int seed = 1234)
    {
        var data = new byte[count];
        new Random(seed).NextBytes(data);
        return data;
    }
}

/// <summary>In-memory scan source with explicit covered ranges.</summary>
public sealed class MemoryScanSource(byte[] data, IReadOnlyList<LongRange>? covered = null) : IPar2ScanSource
{
    public long Length => data.Length;

    public IReadOnlyList<LongRange> CoveredRanges { get; } =
        covered ?? [new LongRange(0, data.Length)];

    public int ReadCount { get; private set; }

    public void ReadAt(long offset, Span<byte> destination)
    {
        ReadCount++;
        data.AsSpan((int)offset, destination.Length).CopyTo(destination);
    }
}

/// <summary>In-memory block IO over original file bytes plus scanned recovery slices.</summary>
public sealed class MemoryBlockIo : IPar2BlockIo
{
    private readonly Par2SetInfo _set;
    private readonly IReadOnlyList<byte[]> _files;
    private readonly Dictionary<uint, byte[]> _recovery;

    public Dictionary<int, byte[]> RecoveredSlices { get; } = [];

    public MemoryBlockIo(Par2SetInfo set, IReadOnlyList<byte[]> filesInSetOrder, Dictionary<uint, byte[]> recoverySlices)
    {
        _set = set;
        _files = filesInSetOrder;
        _recovery = recoverySlices;
    }

    public ValueTask ReadPresentSliceAsync(int globalSliceIndex, Memory<byte> destination, CancellationToken ct)
    {
        destination.Span.Clear();
        var (fileIndex, offset) = Locate(globalSliceIndex);
        var data = _files[fileIndex];
        var take = (int)Math.Min(destination.Length, data.Length - offset);
        if (take > 0)
            data.AsSpan((int)offset, take).CopyTo(destination.Span);
        return ValueTask.CompletedTask;
    }

    public ValueTask ReadRecoverySliceAsync(uint exponent, Memory<byte> destination, CancellationToken ct)
    {
        _recovery[exponent].CopyTo(destination);
        return ValueTask.CompletedTask;
    }

    public ValueTask WriteRecoveredSliceAsync(int globalSliceIndex, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        RecoveredSlices[globalSliceIndex] = data.ToArray();
        return ValueTask.CompletedTask;
    }

    private (int FileIndex, long Offset) Locate(int globalSliceIndex)
    {
        for (var i = 0; i < _set.Files.Count; i++)
        {
            var file = _set.Files[i];
            if (globalSliceIndex < file.GlobalSliceOffset + file.SliceCount)
                return (i, (globalSliceIndex - file.GlobalSliceOffset) * _set.SliceSize);
        }
        throw new ArgumentOutOfRangeException(nameof(globalSliceIndex));
    }
}
