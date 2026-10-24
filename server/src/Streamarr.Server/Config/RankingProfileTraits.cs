using System.Text.RegularExpressions;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Config;

/// <summary>Describes profiles for viewers (derived traits only, nothing an operator configured as rules) and builds the shared DTOs.</summary>
public static partial class RankingProfileTraits
{
    private static readonly string[] Heights = ["2160p", "1080p", "720p", "480p"];

    [GeneratedRegex(@"\bhdr|dolby\s*vision|\bdv\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex HdrFormat();

    public static RankingProfileTraitsDto From(QualityProfile profile)
    {
        var resolutions = profile.PreferredResolutions.Select(r => r.ToLowerInvariant()).ToList();
        var hdr = profile.CustomFormats.Where(f => HdrFormat().IsMatch(f.Name)).Select(f => f.Score).ToList();
        return new RankingProfileTraitsDto
        {
            PreferredResolution = resolutions.FirstOrDefault(),
            MaxResolution = Heights.FirstOrDefault(resolutions.Contains),
            Hdr = hdr.Any(score => score > 0) ? "prefer" : hdr.Count > 0 && hdr.All(score => score < 0) ? "avoid" : null,
            Codec = profile.PreferredCodecs.FirstOrDefault()?.ToLowerInvariant() switch
            {
                "x265" or "h265" or "hevc" => "hevc",
                "av1" => "av1",
                "x264" or "h264" or "avc" => "h264",
                _ => null,
            },
            Languages = profile.PreferredLanguages.Take(3).ToList(),
            SavesBandwidth = resolutions.Count > 0 && !resolutions.Contains("2160p"),
        };
    }

    public static IReadOnlyList<string> MediaTypes(QualityProfile profile)
        => new[] { (MediaType.Movie, "movie"), (MediaType.Tv, "series") }
            .Where(t => profile.AppliesToMediaType(t.Item1)).Select(t => t.Item2).ToList();

    public static RankingProfileRefDto Ref(ResolvedProfile resolved)
        => new() { Id = resolved.Profile.Id, Name = resolved.Profile.Name, Source = resolved.Source };
}
