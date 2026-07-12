using Streamarr.Core.Ranking;

namespace Streamarr.Core.Profiles;

/// <summary>
/// Built-in quality profiles. The default (<see cref="Standard"/>) ships so the ranker
/// produces sane orderings out of the box (BRIEF.md §7.3), before an operator creates
/// their own via the config API in M3.
/// </summary>
public static class DefaultProfiles
{
    /// <summary>
    /// A sensible general-purpose profile: prefer a 1080p WEB-DL/BluRay x265 encode
    /// with modern audio, tolerate 2160p and 720p, using Radarr-derived size bands.
    /// </summary>
    public static QualityProfile Standard { get; } = new()
    {
        Id = "default",
        Name = "Standard",
        IsDefault = true,
        PreferredResolutions = ["1080p", "2160p", "720p", "480p"],
        PreferredSources = ["BluRay", "WEB-DL", "Remux", "WEBRip", "HDTV"],
        PreferredCodecs = ["x265", "x264"],
        PreferredLanguages = ["en"],
        SizeBands = QualityDefinitions.DefaultSizeBands,
    };
}
