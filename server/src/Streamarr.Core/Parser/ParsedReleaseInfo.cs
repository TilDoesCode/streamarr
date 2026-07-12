namespace Streamarr.Core.Parser;

/// <summary>Broad media classification inferred from a release name.</summary>
public enum ParsedMediaType
{
    Unknown,
    Movie,
    Tv,
}

/// <summary>
/// The full structured parse of a raw Usenet release name, covering everything in
/// BRIEF.md §7.1: resolution, source, codec, HDR flavor, audio codec + channels,
/// release group, edition, PROPER/REPACK, languages (incl. multi / dual-audio) and,
/// for TV, season/episode/daily/absolute (anime) numbering.
/// </summary>
public sealed record ParsedReleaseInfo
{
    /// <summary>The raw release name that was parsed.</summary>
    public required string ReleaseName { get; init; }

    /// <summary>Cleaned work title (series or movie), separators normalized to spaces.</summary>
    public string? Title { get; init; }

    /// <summary>Release year for movies (or the series year when present).</summary>
    public int? Year { get; init; }

    public ParsedMediaType MediaType { get; init; } = ParsedMediaType.Unknown;

    // ---- Quality (BRIEF §7.1) ----

    /// <summary><c>2160p | 1080p | 720p | 576p | 540p | 480p | 360p | SD</c>.</summary>
    public string? Resolution { get; init; }

    /// <summary><c>BluRay | Remux | WEB-DL | WEBRip | HDTV | BDRip | BRRip | DVD | DVDR | SCR | CAM | TS | TC | WORKPRINT | PDTV | SDTV | TVRip | DSR</c>.</summary>
    public string? Source { get; init; }

    /// <summary><c>x265 | x264 | AV1 | XviD | DivX | VC-1 | MPEG-2</c>.</summary>
    public string? VideoCodec { get; init; }

    /// <summary>HDR flavor: <c>DV | HDR10+ | HDR10 | HLG | SDR</c> (null when not indicated).</summary>
    public string? Hdr { get; init; }

    /// <summary>Audio codec, e.g. <c>TrueHD | DTS-HD MA | DTS-X | DTS | DDP | DD | AAC | FLAC | Opus | MP3</c>.</summary>
    public string? AudioCodec { get; init; }

    /// <summary>Channel layout, e.g. <c>7.1 | 5.1 | 2.0 | 1.0</c>.</summary>
    public string? AudioChannels { get; init; }

    /// <summary>True when a Dolby Atmos tag is present.</summary>
    public bool Atmos { get; init; }

    public string? ReleaseGroup { get; init; }

    /// <summary>Edition tag, e.g. <c>Extended | Directors Cut | Uncut | IMAX | Remastered</c>.</summary>
    public string? Edition { get; init; }

    public bool Proper { get; init; }
    public bool Repack { get; init; }

    /// <summary>Revision version (v2/v3, PROPER/REPACK bump). 1 = original.</summary>
    public int Version { get; init; } = 1;

    // ---- Languages (BRIEF §7.1) ----

    /// <summary>Detected spoken languages as ISO 639-1 codes, in detection order.</summary>
    public IReadOnlyList<string> Languages { get; init; } = [];

    /// <summary>Explicit MULTi marker present.</summary>
    public bool MultiLanguage { get; init; }

    /// <summary>Explicit dual-audio marker present (anime / German DL).</summary>
    public bool DualAudio { get; init; }

    // ---- TV (BRIEF §7.1) ----

    public int? Season { get; init; }

    /// <summary>Episode numbers (multi-episode releases carry more than one).</summary>
    public IReadOnlyList<int> Episodes { get; init; } = [];

    /// <summary>Absolute episode numbers (anime).</summary>
    public IReadOnlyList<int> AbsoluteEpisodes { get; init; } = [];

    /// <summary>True for a season pack (no episode number, or a multi-season range).</summary>
    public bool SeasonPack { get; init; }

    /// <summary>Highest season in a multi-season pack (e.g. S01-S03 → 3), else null.</summary>
    public int? SeasonEnd { get; init; }

    /// <summary>Daily-episode air date in ISO <c>yyyy-MM-dd</c> form.</summary>
    public string? AirDate { get; init; }

    public bool IsDaily { get; init; }
}
