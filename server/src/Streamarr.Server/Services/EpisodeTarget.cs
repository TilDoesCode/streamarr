using System.Globalization;
using System.Text.RegularExpressions;
using Streamarr.Core.Parser;

namespace Streamarr.Server.Services;

/// <summary>
/// The specific episode a resolve is asking for, parsed from a canonical episode
/// workId (<c>tmdb-tv-{id}-sNNeNN</c>). It selects the matching payload inside a
/// multi-episode release: the right file of a season pack's NZB, or the right
/// stored entry inside a pack's RAR set. Null when the work is not an episode.
/// </summary>
public readonly partial record struct EpisodeTarget(int Season, int Episode)
{
    [GeneratedRegex(
        "^tmdb-tv-[1-9][0-9]*-s(?<season>[0-9]{1,4})e(?<episode>[0-9]{1,4})$",
        RegexOptions.CultureInvariant)]
    private static partial Regex EpisodeWorkIdPattern();

    public static EpisodeTarget? FromWorkId(string? workId)
    {
        if (string.IsNullOrWhiteSpace(workId))
            return null;
        var match = EpisodeWorkIdPattern().Match(workId);
        if (!match.Success
            || !int.TryParse(match.Groups["season"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var season)
            || !int.TryParse(match.Groups["episode"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var episode))
        {
            return null;
        }

        return new EpisodeTarget(season, episode);
    }

    /// <summary>Stable per-episode discriminator for cache keys ("s01e15").</summary>
    public string CacheDiscriminator
        => string.Create(CultureInfo.InvariantCulture, $"s{Season:D2}e{Episode:D2}");

    public override string ToString()
        => string.Create(CultureInfo.InvariantCulture, $"S{Season:D2}E{Episode:D2}");

    /// <summary>
    /// True when a file name (an NZB subject file or a path inside a RAR set) carries
    /// this episode's numbering. The season must match when the name declares one;
    /// names without a season (e.g. "E05" inside a single-season pack) still match.
    /// </summary>
    public bool MatchesFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
            return false;

        var name = fileName.Replace('\\', '/');
        name = name[(name.LastIndexOf('/') + 1)..];
        if (MatchesParsedName(name))
            return true;

        // Retry without the extension — but only when one was actually removed. An
        // archive base name such as "Show.S01E15" must not lose its episode marker
        // to Path.GetFileNameWithoutExtension treating ".S01E15" as an extension.
        var withoutExtension = Path.GetFileNameWithoutExtension(name);
        return withoutExtension.Length > 0
               && !string.Equals(withoutExtension, name, StringComparison.Ordinal)
               && MatchesParsedName(withoutExtension);
    }

    private bool MatchesParsedName(string name)
    {
        var parsed = EpisodeParser.Parse(name);
        if (parsed is null || parsed.SeasonPack)
            return false;
        if (parsed.Season is { } season && season != Season)
            return false;
        return parsed.Episodes.Contains(Episode);
    }
}
