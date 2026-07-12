// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Utils/RarUtil.cs + backend/Queue/FileProcessors/RarProcessor.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// password/AES support dropped; header walk + part-number detection consolidated.

using System.Text.RegularExpressions;
using SharpCompress.Common.Rar.Headers;
using SharpCompress.IO;
using SharpCompress.Readers;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Rar;

/// <summary>One stored (uncompressed) file slice inside a single RAR volume.</summary>
public sealed record RarStoredSlice
{
    /// <summary>Path of the file within the archive.</summary>
    public required string PathWithinArchive { get; init; }

    /// <summary>Raw byte range of this slice's data within the volume file.</summary>
    public required LongRange ByteRangeWithinPart { get; init; }

    /// <summary>Full uncompressed size of the archived file (across all volumes).</summary>
    public required long FileUncompressedSize { get; init; }

    /// <summary>True when this slice continues a file started in a previous volume.</summary>
    public required bool IsSplitBefore { get; init; }

    /// <summary>True when this slice's file continues into the next volume.</summary>
    public required bool IsSplitAfter { get; init; }
}

/// <summary>The parsed headers of a single RAR volume (.rar / .rNN / .partNN.rar).</summary>
public sealed record RarVolume
{
    public required string FileName { get; init; }
    public required long PartSize { get; init; }
    public required bool IsRar5 { get; init; }
    public required int? PartNumberFromHeader { get; init; }
    public required int? PartNumberFromFilename { get; init; }
    public required IReadOnlyList<RarStoredSlice> Slices { get; init; }

    /// <summary>
    /// Effective ordering key of this volume within its set. Filename numbering is
    /// preferred (always available in an NZB context); header numbering is the
    /// fallback. A plain first volume (<c>.rar</c>) sorts before <c>.r00</c>.
    /// </summary>
    public int PartNumber => PartNumberFromFilename
                             ?? PartNumberFromHeader
                             ?? throw new InvalidDataException(
                                 $"Could not determine part number for RAR volume '{FileName}'.");
}

public static partial class RarVolumeReader
{
    /// <summary>
    /// Walks the RAR headers of one volume (RAR4 or RAR5) on a seekable stream
    /// without reading file data, and maps every stored file's raw byte range.
    /// Throws <see cref="UnsupportedRarCompressionMethodException"/> when an entry
    /// uses real compression — release RARs are stored (m0).
    /// </summary>
    public static async Task<RarVolume> ReadAsync
    (
        Stream stream,
        string fileName,
        CancellationToken ct
    )
    {
        var headers = await Task.Run(() => ReadHeaders(stream, ct), ct).ConfigureAwait(false);

        var slices = headers
            .Where(x => x.HeaderType == HeaderType.File)
            .Select(x => new RarStoredSlice
            {
                PathWithinArchive = x.GetFileName(),
                ByteRangeWithinPart = LongRange.FromStartAndSize(
                    x.GetDataStartPosition(),
                    x.GetAdditionalDataSize()),
                FileUncompressedSize = x.GetUncompressedSize(),
                IsSplitBefore = x.GetIsSplitBefore(),
                IsSplitAfter = x.GetIsSplitAfter(),
            })
            .ToList();

        return new RarVolume
        {
            FileName = fileName,
            PartSize = stream.CanSeek ? stream.Length : -1,
            IsRar5 = headers.Count > 0 && headers[0].GetIsRar5(),
            PartNumberFromHeader = GetPartNumberFromHeaders(headers),
            PartNumberFromFilename = GetPartNumberFromFilename(fileName),
            Slices = slices,
        };
    }

    private static List<IRarHeader> ReadHeaders(Stream stream, CancellationToken ct)
    {
        var readerOptions = new ReaderOptions();
        var headerFactory = new RarHeaderFactory(StreamingMode.Seekable, readerOptions);
        var headers = new List<IRarHeader>();
        foreach (var header in headerFactory.ReadHeaders(stream))
        {
            ct.ThrowIfCancellationRequested();

            // keep archive headers (they carry the volume number)
            if (header.HeaderType is HeaderType.Archive or HeaderType.EndArchive)
            {
                headers.Add(header);
                continue;
            }

            // skip comments
            if (header.HeaderType == HeaderType.Service)
            {
                if (header.GetFileName() == "CMT")
                {
                    var buffer = new byte[header.GetCompressedSize()];
                    _ = stream.Read(buffer, 0, buffer.Length);
                }

                continue;
            }

            // we only care about file headers
            if (header.HeaderType != HeaderType.File || header.IsDirectory() ||
                header.GetFileName() == "QO") continue;

            // we only support stored files (compression method m0).
            if (header.GetCompressionMethod() != 0)
                throw new UnsupportedRarCompressionMethodException(
                    "Only rar files with compression method m0 are supported.");

            // password-protected archives are rejected during release selection.
            if (header.GetIsEncrypted())
                throw new UnsupportedRarCompressionMethodException(
                    "Encrypted rar entries are not supported.");

            headers.Add(header);
        }

        return headers;
    }

    private static int? GetPartNumberFromHeaders(List<IRarHeader> headers)
    {
        var archiveHeader = headers.FirstOrDefault(x => x.HeaderType is HeaderType.Archive);
        var archiveVolumeNumber = archiveHeader?.GetVolumeNumber();
        if (archiveVolumeNumber != null) return archiveVolumeNumber.Value;

        var endHeader = headers.FirstOrDefault(x => x.HeaderType == HeaderType.EndArchive);
        var endVolumeNumber = endHeader?.GetVolumeNumber();
        if (endVolumeNumber != null) return endVolumeNumber.Value;

        if (archiveHeader?.GetIsFirstVolume() == true) return -1;
        return null;
    }

    public static int? GetPartNumberFromFilename(string filename)
    {
        // handle the `.partXXX.rar` format
        var partMatch = PartNumberRegex().Match(filename);
        if (partMatch.Success)
            return int.Parse(partMatch.Groups[1].Value);

        // handle the `.rXXX` format
        var rMatch = RNumberRegex().Match(filename);
        if (rMatch.Success)
            return int.Parse(rMatch.Groups[1].Value);

        // handle the `.rar` format.
        if (filename.EndsWith(".rar", StringComparison.OrdinalIgnoreCase))
            return -1;

        //  could not determine from filename
        return null;
    }

    /// <summary>Removes the .rar extension and the .partXX suffix if present.</summary>
    public static string GetArchiveName(string fileName)
    {
        var sansExtension = Path.GetFileNameWithoutExtension(fileName);
        sansExtension = PartSuffixRegex().Replace(sansExtension, "");
        return sansExtension;
    }

    [GeneratedRegex(@"\.part(\d+)\.rar$", RegexOptions.IgnoreCase)]
    private static partial Regex PartNumberRegex();

    [GeneratedRegex(@"\.r(\d+)$", RegexOptions.IgnoreCase)]
    private static partial Regex RNumberRegex();

    [GeneratedRegex(@"\.part\d+$", RegexOptions.IgnoreCase)]
    private static partial Regex PartSuffixRegex();
}
