namespace Streamarr.Usenet.Par2;

/// <summary>
/// Hard bounds applied while parsing untrusted PAR2 data. Every allocation the parser
/// makes is bounded by these values.
/// </summary>
public sealed record Par2ParserLimits
{
    public static Par2ParserLimits Default { get; } = new();

    /// <summary>Largest accepted single packet (header + body).</summary>
    public long MaxPacketBytes { get; init; } = 256L * 1024 * 1024;

    /// <summary>Largest accepted slice (block) size.</summary>
    public long MaxSliceSize { get; init; } = 128L * 1024 * 1024;

    /// <summary>Most files allowed in one recovery set.</summary>
    public int MaxFiles { get; init; } = 256;

    /// <summary>Largest accepted single source file.</summary>
    public long MaxFileLength { get; init; } = 256L * 1024 * 1024 * 1024;

    /// <summary>Most source slices across the whole set (PAR2 caps input slices at 32768).</summary>
    public long MaxTotalSlices { get; init; } = 32_768;

    /// <summary>Longest accepted declared file name (bytes).</summary>
    public int MaxFileNameBytes { get; init; } = 512;

    /// <summary>Most packets examined in one file before scanning aborts.</summary>
    public int MaxPacketsPerFile { get; init; } = 100_000;
}
