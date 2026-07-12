// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Models/UsenetYencHeader.cs @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr (properties instead of fields).

namespace Streamarr.Usenet.Yenc;

/// <summary>
/// Parsed <c>=ybegin</c>/<c>=ypart</c> header values of a yEnc-encoded article.
/// </summary>
public record YencHeader
{
    public required string FileName { get; init; }
    public required long FileSize { get; init; }
    public required int LineLength { get; init; }
    public required int PartNumber { get; init; }
    public required int TotalParts { get; init; }
    /// <summary>Decoded size of this part in bytes.</summary>
    public required long PartSize { get; init; }
    /// <summary>Zero-based offset of this part's first byte within the whole file.</summary>
    public required long PartOffset { get; init; }

    public bool IsFilePart => PartNumber > 0;
}
