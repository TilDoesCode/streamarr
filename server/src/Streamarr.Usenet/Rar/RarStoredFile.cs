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

    /// <summary>
    /// Raw byte range of the slice within that volume file. For an encrypted slice,
    /// this ciphertext range may extend up to 15 bytes past the slice's true
    /// contribution to <see cref="ByteRangeWithinFile"/> (AES-CBC block padding —
    /// RAR encrypts each volume's contribution to a file independently, so any
    /// slice, not only the file's last, may pad its own tail).
    /// </summary>
    public required LongRange ByteRangeWithinPart { get; init; }

    /// <summary>Plaintext byte range this slice covers within the extracted file.</summary>
    public required LongRange ByteRangeWithinFile { get; init; }

    /// <summary>
    /// Non-null when this slice's on-disk bytes are RAR5 AES-256-CBC ciphertext. Each
    /// volume's contribution to a file is encrypted independently starting from its
    /// own IV (confirmed against SharpCompress's own decompression of a multi-volume
    /// fixture) — so this is per-*slice*, not per-file: crossing into the next volume
    /// means restarting the CBC chain from that slice's own <see cref="RarFileCrypto.InitV"/>,
    /// never continuing the previous slice's chain.
    /// </summary>
    public RarFileCrypto? Crypto { get; init; }
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

    /// <summary>True when any slice of this file is RAR5 AES-256-CBC encrypted.</summary>
    public bool IsEncrypted => Slices.Any(s => s.Crypto is not null);
}

public static class RarArchiveIndexer
{
    public const int MaxVolumes = 1_024;
    private const int MaxTotalSlices = 100_000;
    private const int MaxStoredFiles = 10_000;

    /// <summary>
    /// Aggregates the parsed volumes of one RAR set (single- or multi-volume,
    /// RAR4 or RAR5) into per-file random-access maps. Volumes may be supplied
    /// in any order; they are sorted by part number.
    /// </summary>
    public static IReadOnlyList<RarStoredFile> Index(IEnumerable<RarVolume> volumes)
    {
        ArgumentNullException.ThrowIfNull(volumes);
        var orderedVolumes = volumes.Take(MaxVolumes + 1).OrderBy(x => x.PartNumber).ToList();
        if (orderedVolumes.Count > MaxVolumes)
            throw new InvalidDataException($"RAR sets may contain at most {MaxVolumes} volumes.");
        if (orderedVolumes.Select(volume => volume.PartNumber).Distinct().Count() != orderedVolumes.Count)
            throw new InvalidDataException("RAR set contains duplicate volume numbers.");

        var files = new List<RarStoredFile>();
        var slicesByPath = new Dictionary<string, List<RarStoredFileSlice>>();
        var sizeByPath = new Dictionary<string, long>();
        var pathOrder = new List<string>();
        var totalSlices = 0;

        for (var partIndex = 0; partIndex < orderedVolumes.Count; partIndex++)
        {
            foreach (var slice in orderedVolumes[partIndex].Slices)
            {
                totalSlices++;
                if (totalSlices > MaxTotalSlices)
                    throw new InvalidDataException("RAR set contains too many stored-file slices.");

                if (!slicesByPath.TryGetValue(slice.PathWithinArchive, out var slices))
                {
                    if (slicesByPath.Count >= MaxStoredFiles)
                        throw new InvalidDataException("RAR set contains too many stored files.");
                    slices = [];
                    slicesByPath[slice.PathWithinArchive] = slices;
                    sizeByPath[slice.PathWithinArchive] = slice.FileUncompressedSize;
                    pathOrder.Add(slice.PathWithinArchive);
                }
                else if (sizeByPath[slice.PathWithinArchive] != slice.FileUncompressedSize)
                {
                    throw new InvalidDataException("RAR set contains inconsistent file-size headers.");
                }

                var fileOffset = slices.Count == 0 ? 0 : slices[^1].ByteRangeWithinFile.EndExclusive;
                var declaredTotal = sizeByPath[slice.PathWithinArchive];

                // Each volume's contribution to an encrypted file is its own independent
                // CBC stream, so its ciphertext is padded up to the AES block size
                // independently of any other slice. Clamp so the aggregate plaintext map
                // always sums to exactly the declared size, regardless of trailing padding
                // on any one slice (in practice only ever the file's true last slice, since
                // archivers align non-final volume splits to the block size).
                var plaintextCount = slice.Crypto is null
                    ? slice.ByteRangeWithinPart.Count
                    : Math.Min(slice.ByteRangeWithinPart.Count, Math.Max(0, declaredTotal - fileOffset));

                try
                {
                    slices.Add(new RarStoredFileSlice
                    {
                        PartIndex = partIndex,
                        ByteRangeWithinPart = slice.ByteRangeWithinPart,
                        ByteRangeWithinFile = LongRange.FromStartAndSize(fileOffset, plaintextCount),
                        Crypto = slice.Crypto,
                    });
                }
                catch (Exception exception) when (exception is OverflowException or ArgumentOutOfRangeException)
                {
                    throw new InvalidDataException("RAR set contains an invalid aggregate file range.", exception);
                }
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
