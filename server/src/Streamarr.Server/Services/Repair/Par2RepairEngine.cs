using Streamarr.Usenet.Par2;

namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Narrow, testable seam over the verifying PAR2 reconstruction implementation
/// (<see cref="Par2RecoveryEngine"/>). There is no pretend-repair path: the engine
/// either produces slices that later pass IFSC/MD5 verification, or the job fails.
/// </summary>
public interface IPar2RepairEngine
{
    Task ReconstructAsync(
        Par2SetInfo set,
        IReadOnlyList<int> missingGlobalIndices,
        IReadOnlyList<uint> exponents,
        IPar2BlockIo io,
        IProgress<Par2ReconstructionProgress>? progress,
        CancellationToken ct);
}

public sealed class Par2RepairEngine : IPar2RepairEngine
{
    public Task ReconstructAsync(
        Par2SetInfo set,
        IReadOnlyList<int> missingGlobalIndices,
        IReadOnlyList<uint> exponents,
        IPar2BlockIo io,
        IProgress<Par2ReconstructionProgress>? progress,
        CancellationToken ct)
        => Par2RecoveryEngine.ReconstructAsync(set, missingGlobalIndices, exponents, io, progress, ct);
}

/// <summary>
/// Slice IO over the staging workspace: present/recovered slices live in the sparse
/// source files, recovery slices in the partially materialized volume files.
/// </summary>
public sealed class WorkspaceBlockIo(
    Par2SetInfo set,
    IReadOnlyList<SparseRepairFile> sourceFilesInSetOrder,
    IReadOnlyDictionary<uint, (SparseRepairFile Volume, Par2RecoverySliceRef Slice)> recoverySlices)
    : IPar2BlockIo
{
    public ValueTask ReadPresentSliceAsync(int globalSliceIndex, Memory<byte> destination, CancellationToken ct)
    {
        var (fileIndex, offset) = Locate(globalSliceIndex);
        var file = sourceFilesInSetOrder[fileIndex];
        var take = (int)Math.Min(destination.Length, file.Length - offset);
        destination.Span.Clear();
        file.ReadAt(offset, destination.Span[..take]);
        return ValueTask.CompletedTask;
    }

    public ValueTask ReadRecoverySliceAsync(uint exponent, Memory<byte> destination, CancellationToken ct)
    {
        var (volume, slice) = recoverySlices[exponent];
        volume.ReadAt(slice.DataOffset, destination.Span[..(int)slice.DataLength]);
        return ValueTask.CompletedTask;
    }

    public ValueTask WriteRecoveredSliceAsync(int globalSliceIndex, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        var (fileIndex, offset) = Locate(globalSliceIndex);
        var file = sourceFilesInSetOrder[fileIndex];
        var take = (int)Math.Min(data.Length, file.Length - offset);
        file.WriteAt(offset, data.Span[..take]);
        return ValueTask.CompletedTask;
    }

    private (int FileIndex, long Offset) Locate(int globalSliceIndex)
    {
        for (var i = 0; i < set.Files.Count; i++)
        {
            var file = set.Files[i];
            if (globalSliceIndex < file.GlobalSliceOffset + file.SliceCount)
                return (i, (globalSliceIndex - file.GlobalSliceOffset) * set.SliceSize);
        }
        throw new ArgumentOutOfRangeException(nameof(globalSliceIndex));
    }
}
