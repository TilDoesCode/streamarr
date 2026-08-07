namespace Streamarr.Usenet.Par2;

/// <summary>One source file of a validated recovery set, in Main-packet order.</summary>
public sealed record Par2SourceFileInfo
{
    public required Par2FileDescription Description { get; init; }

    public required Par2FileSliceChecksums Checksums { get; init; }

    /// <summary>Number of slices covering this file (last one zero-padded).</summary>
    public required int SliceCount { get; init; }

    /// <summary>Global input-slice index of this file's first slice.</summary>
    public required long GlobalSliceOffset { get; init; }
}

/// <summary>
/// A fully validated PAR2 recovery set built from the index file: every packet MD5
/// verified, ids cross-checked, slice counts consistent with declared file lengths.
/// </summary>
public sealed record Par2SetInfo
{
    public required byte[] SetId { get; init; }

    public required long SliceSize { get; init; }

    /// <summary>Recovery-set files in Main-packet order (defines global slice indexing).</summary>
    public required IReadOnlyList<Par2SourceFileInfo> Files { get; init; }

    public required long TotalSlices { get; init; }

    /// <summary>Packets that carried a different set id and were ignored.</summary>
    public required int ForeignPackets { get; init; }

    public Par2SourceFileInfo? FindFile(Par2FileId fileId)
        => Files.FirstOrDefault(f => f.Description.FileId == fileId);

    /// <summary>Maps a byte range of one file to the global slice indices it touches.</summary>
    public IEnumerable<int> SliceIndicesForRange(int fileIndex, long startInclusive, long endExclusive)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(fileIndex);
        ArgumentOutOfRangeException.ThrowIfGreaterThanOrEqual(fileIndex, Files.Count);
        var file = Files[fileIndex];
        var length = file.Description.FileLength;
        startInclusive = Math.Clamp(startInclusive, 0, length);
        endExclusive = Math.Clamp(endExclusive, 0, length);
        if (endExclusive <= startInclusive)
            yield break;
        var first = startInclusive / SliceSize;
        var last = (endExclusive - 1) / SliceSize;
        for (var slice = first; slice <= last; slice++)
            yield return checked((int)(file.GlobalSliceOffset + slice));
    }
}
