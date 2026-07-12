// Written for Streamarr. The per-volume header walk it builds on is ported from
// nzbdav (see RarVolume.cs); the multi-volume offset aggregation replaces
// nzbdav's WebDAV/database presentation layers, which Streamarr dropped.

using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Rar;

/// <summary>
/// One slice of a stored file, located within a specific volume of the set.
/// </summary>
public sealed record RarStoredFileSlice
{
    /// <summary>Index into the ordered volume list of the archive set.</summary>
    public required int PartIndex { get; init; }

    /// <summary>Raw byte range of the slice within that volume file.</summary>
    public required LongRange ByteRangeWithinPart { get; init; }

    /// <summary>Byte range this slice covers within the extracted file.</summary>
    public required LongRange ByteRangeWithinFile { get; init; }
}

/// <summary>
/// A stored (uncompressed) file inside a RAR set, with a complete map from
/// file-relative offsets to (volume, raw offset) pairs — the random-access index.
/// </summary>
public sealed record RarStoredFile
{
    public required string PathWithinArchive { get; init; }
    public required long Size { get; init; }
    public required IReadOnlyList<RarStoredFileSlice> Slices { get; init; }
}

public static class RarArchiveIndexer
{
    /// <summary>
    /// Aggregates the parsed volumes of one RAR set (single- or multi-volume,
    /// RAR4 or RAR5) into per-file random-access maps. Volumes may be supplied
    /// in any order; they are sorted by part number.
    /// </summary>
    public static IReadOnlyList<RarStoredFile> Index(IEnumerable<RarVolume> volumes)
    {
        var orderedVolumes = volumes.OrderBy(x => x.PartNumber).ToList();

        var files = new List<RarStoredFile>();
        var slicesByPath = new Dictionary<string, List<RarStoredFileSlice>>();
        var sizeByPath = new Dictionary<string, long>();
        var pathOrder = new List<string>();

        for (var partIndex = 0; partIndex < orderedVolumes.Count; partIndex++)
        {
            foreach (var slice in orderedVolumes[partIndex].Slices)
            {
                if (!slicesByPath.TryGetValue(slice.PathWithinArchive, out var slices))
                {
                    slices = [];
                    slicesByPath[slice.PathWithinArchive] = slices;
                    sizeByPath[slice.PathWithinArchive] = slice.FileUncompressedSize;
                    pathOrder.Add(slice.PathWithinArchive);
                }

                var fileOffset = slices.Count == 0 ? 0 : slices[^1].ByteRangeWithinFile.EndExclusive;
                slices.Add(new RarStoredFileSlice
                {
                    PartIndex = partIndex,
                    ByteRangeWithinPart = slice.ByteRangeWithinPart,
                    ByteRangeWithinFile = LongRange.FromStartAndSize(fileOffset, slice.ByteRangeWithinPart.Count),
                });
            }
        }

        foreach (var path in pathOrder)
        {
            var slices = slicesByPath[path];
            var mappedSize = slices[^1].ByteRangeWithinFile.EndExclusive;
            var declaredSize = sizeByPath[path];

            if (mappedSize != declaredSize)
            {
                throw new InvalidDataException(
                    $"RAR set is incomplete for '{path}': headers declare {declaredSize} bytes " +
                    $"but the volumes only map {mappedSize} bytes.");
            }

            files.Add(new RarStoredFile
            {
                PathWithinArchive = path,
                Size = declaredSize,
                Slices = slices,
            });
        }

        return files;
    }
}
