namespace Streamarr.Core.Profiles;

/// <summary>
/// A quality preference profile driving the release ranker (BRIEF.md §7.3):
/// a transparent weighted sum, structured so a Radarr-style custom-format model
/// can replace it later without changing the API.
/// </summary>
public sealed record QualityProfile
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>Preferred resolutions, best first (e.g. ["1080p", "2160p", "720p"]).</summary>
    public IReadOnlyList<string> PreferredResolutions { get; init; } = [];

    /// <summary>Preferred sources, best first (e.g. ["WEB-DL", "BluRay"]).</summary>
    public IReadOnlyList<string> PreferredSources { get; init; } = [];

    /// <summary>Preferred video codecs, best first (e.g. ["x265", "x264"]).</summary>
    public IReadOnlyList<string> PreferredCodecs { get; init; } = [];

    /// <summary>Preferred audio languages, best first (ISO 639-1).</summary>
    public IReadOnlyList<string> PreferredLanguages { get; init; } = [];

    public IReadOnlyList<string> GroupAllowList { get; init; } = [];
    public IReadOnlyList<string> GroupDenyList { get; init; } = [];

    // Weights of the scoring terms (integer points contributed at full match).
    public int ResolutionWeight { get; init; } = 100;
    public int SourceWeight { get; init; } = 80;
    public int CodecWeight { get; init; } = 40;
    public int LanguageWeight { get; init; } = 60;
    public int AudioWeight { get; init; } = 30;
    public int ProperRepackBonus { get; init; } = 20;
    public int RecencyBonus { get; init; } = 10;
    public int GrabsBonus { get; init; } = 10;

    /// <summary>Sane bytes-per-minute band used for fake/sample rejection.</summary>
    public long MinBytesPerMinute { get; init; } = 3_000_000;
    public long MaxBytesPerMinute { get; init; } = 400_000_000;

    public bool IsDefault { get; init; }
}
