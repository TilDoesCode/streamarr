// Quality tier ordering + default size bands adapted from Radarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Qualities/Quality.cs (DefaultQualityDefinitions
// weights) and QualityDefinition.cs (per-quality size limits).
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// Radarr's combined Quality enum (WEBDL1080p, Bluray2160p, …) is decomposed here into
// independent resolution / source tiers matching Streamarr's parser output, and the
// MB-per-minute size limits become bytes-per-minute bands. Streamarr is GPL-3.0;
// see LICENSE + NOTICE.
using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// Static quality tiers and default size bands used by the ranker and the size-sanity
/// rejection rule. Ported from Radarr's quality definitions; the tier numbers preserve
/// Radarr's ordering (higher = better) so the default ranking matches operator
/// expectations even before a profile expresses explicit preferences.
/// </summary>
public static class QualityDefinitions
{
    private const long Mb = 1_000_000;

    /// <summary>
    /// Resolution tier, higher is better. Mirrors the resolution ordering baked into
    /// Radarr's <c>DefaultQualityDefinitions</c> weights.
    /// </summary>
    public static int ResolutionTier(string? resolution) => resolution switch
    {
        "2160p" => 6,
        "1080p" => 5,
        "720p" => 4,
        "576p" => 3,
        "480p" => 2,
        "540p" => 2,
        "360p" => 1,
        "SD" => 1,
        _ => 0,
    };

    /// <summary>
    /// Source tier, higher is better. Derived from Radarr's per-quality weights
    /// collapsed onto the source dimension (Remux &gt; BluRay &gt; WEB-DL &gt; WEBRip
    /// &gt; HDTV &gt; DVD &gt; screener/telecine/telesync/cam).
    /// </summary>
    public static int SourceTier(string? source) => source switch
    {
        "Remux" => 10,
        "BluRay" => 9,
        "WEB-DL" => 8,
        "WEBRip" => 7,
        "BDRip" => 6,
        "BRRip" => 6,
        "HDTV" => 5,
        "PDTV" => 5,
        "DVDR" => 4,
        "DVD" => 4,
        "SDTV" => 3,
        "TVRip" => 3,
        "DSR" => 3,
        "REGIONAL" => 3,
        "SCR" => 2,
        "TC" => 2,
        "TS" => 1,
        "CAM" => 1,
        "WORKPRINT" => 1,
        _ => 0,
    };

    /// <summary>
    /// Audio tier, higher is better: lossless (TrueHD / DTS-HD MA / DTS-X / FLAC) &gt;
    /// high-bitrate lossy (DTS / DDP) &gt; DD / AAC &gt; MP3.
    /// </summary>
    public static int AudioTier(string? audioCodec) => audioCodec switch
    {
        "TrueHD" => 6,
        "DTS-HD MA" => 6,
        "DTS-X" => 6,
        "LPCM" => 6,
        "FLAC" => 5,
        "DTS-HD" => 5,
        "DTS-ES" => 4,
        "DTS" => 4,
        "DDP" => 4,
        "DD" => 3,
        "Opus" => 3,
        "AAC" => 2,
        "MP3" => 1,
        _ => 0,
    };

    /// <summary>Highest resolution tier, used to normalize tier scores to weights.</summary>
    public const int MaxResolutionTier = 6;
    public const int MaxSourceTier = 10;
    public const int MaxAudioTier = 6;

    /// <summary>
    /// Sensible default per-resolution bytes-per-minute bands. Lower bound rejects
    /// padded fakes / mislabelled samples; upper bound rejects absurdly oversized
    /// (often fake or wrongly-labelled) uploads. Generous enough that a legitimate
    /// Remux never trips the ceiling.
    /// </summary>
    public static IReadOnlyDictionary<string, SizeBand> DefaultSizeBands { get; } =
        new Dictionary<string, SizeBand>(StringComparer.OrdinalIgnoreCase)
        {
            ["SD"] = Band(1, 60),
            ["360p"] = Band(1, 40),
            ["480p"] = Band(2, 80),
            ["540p"] = Band(2, 90),
            ["576p"] = Band(3, 100),
            ["720p"] = Band(4, 220),
            ["1080p"] = Band(6, 450),
            ["2160p"] = Band(15, 1500),
        };

    private static SizeBand Band(long minMbPerMin, long maxMbPerMin) => new()
    {
        MinBytesPerMinute = minMbPerMin * Mb,
        MaxBytesPerMinute = maxMbPerMin * Mb,
    };
}
