using Streamarr.Core.Media;
using Streamarr.Core.Parser;

namespace Streamarr.Core.Ranking;

/// <summary>
/// Summary of an NZB's contents used by the post-resolve rejection rules
/// (password / non-media / incomplete). Null at search time — those rules simply do
/// not fire until a resolve has inspected the NZB.
/// </summary>
public sealed record NzbInspection
{
    /// <summary>The NZB (or its archive) is password-protected.</summary>
    public bool PasswordProtected { get; init; }

    /// <summary>File names contained in the NZB (used to spot non-media payloads).</summary>
    public IReadOnlyList<string> FileNames { get; init; } = [];

    /// <summary>Files the upload should contain (e.g. from a par2 set), when known.</summary>
    public int? ExpectedFileCount { get; init; }

    /// <summary>Files actually present in the NZB.</summary>
    public int PresentFileCount { get; init; }

    /// <summary>Total article segments referenced by the NZB.</summary>
    public long TotalSegments { get; init; }

    /// <summary>Segments known to be missing (from the health check), when known.</summary>
    public long MissingSegments { get; init; }
}

/// <summary>
/// The neutral input to the rejection engine and ranker. Deliberately independent of
/// the <see cref="Release"/> API DTO and of Jellyfin, so the engine is a pure domain
/// function testable in isolation. Built from a <see cref="ParsedReleaseInfo"/> at
/// search time and enriched with runtime / health / NZB signals at resolve time.
/// </summary>
public sealed record ReleaseSignals
{
    public string ReleaseName { get; init; } = string.Empty;
    public long SizeBytes { get; init; }

    /// <summary>TMDB runtime of the matched work, when known (drives size sanity).</summary>
    public int? RuntimeMinutes { get; init; }

    public int AgeDays { get; init; }
    public int Grabs { get; init; }

    public string? Resolution { get; init; }
    public string? Source { get; init; }
    public string? VideoCodec { get; init; }
    public string? AudioCodec { get; init; }
    public string? ReleaseGroup { get; init; }
    public IReadOnlyList<string> Languages { get; init; } = [];
    public bool Proper { get; init; }
    public bool Repack { get; init; }

    /// <summary>Health-check outcome; <see cref="ReleaseHealth.Dead"/> is a rejection.</summary>
    public ReleaseHealth Health { get; init; } = ReleaseHealth.Unknown;

    /// <summary>Present only after a resolve has inspected the NZB.</summary>
    public NzbInspection? Nzb { get; init; }

    /// <summary>Build signals from a parsed release name plus indexer/TMDB context.</summary>
    public static ReleaseSignals FromParsed(
        ParsedReleaseInfo parsed,
        long sizeBytes,
        int? runtimeMinutes = null,
        int ageDays = 0,
        int grabs = 0,
        ReleaseHealth health = ReleaseHealth.Unknown,
        NzbInspection? nzb = null)
    {
        ArgumentNullException.ThrowIfNull(parsed);

        return new ReleaseSignals
        {
            ReleaseName = parsed.ReleaseName,
            SizeBytes = sizeBytes,
            RuntimeMinutes = runtimeMinutes,
            AgeDays = ageDays,
            Grabs = grabs,
            Resolution = parsed.Resolution,
            Source = parsed.Source,
            VideoCodec = parsed.VideoCodec,
            AudioCodec = parsed.AudioCodec,
            ReleaseGroup = parsed.ReleaseGroup,
            Languages = parsed.Languages,
            Proper = parsed.Proper,
            Repack = parsed.Repack,
            Health = health,
            Nzb = nzb,
        };
    }
}
