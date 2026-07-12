// Ported from Sonarr (GPL-3.0).
// Source: Sonarr — src/NzbDrone.Core/Parser/Parser.cs (ReportTitleRegex episode patterns)
// https://github.com/Sonarr/Sonarr  commit f9e18a7c4475345f325237670d7e71ceac97038b
// A curated subset of Sonarr's episode regexes: SxxEyy (single + multi), 4-digit
// seasons, season packs, multi-season packs, daily-date and absolute (anime) numbering.
// Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Globalization;
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Structured TV numbering parsed from a release name.</summary>
public sealed record EpisodeResult
{
    public string? Title { get; init; }
    public int? Season { get; init; }
    public IReadOnlyList<int> Episodes { get; init; } = [];
    public IReadOnlyList<int> AbsoluteEpisodes { get; init; } = [];
    public bool SeasonPack { get; init; }
    public int? SeasonEnd { get; init; }
    public string? AirDate { get; init; }
    public bool IsDaily { get; init; }
    public string? Subgroup { get; init; }
}

public static class EpisodeParser
{
    private static readonly Regex DailyRegex = new(
        @"^(?<title>.+?)[-_. ]+(?<airyear>19[4-9]\d|20\d\d)[-_. ]+(?<airmonth>0[1-9]|1[0-2])[-_. ]+(?<airday>0[1-9]|[12]\d|3[01])(?![-_. ]?\d)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Multi-season pack (S01-S03, Season 1 - Season 3, etc)
    private static readonly Regex MultiSeasonRegex = new(
        @"^(?<title>.+?)(?:[-_. ]+Complete)?[-_. ]+(?:S|(?:Season|Saison|Series|Stagione)[_. ])(?<season>(?<!\d)\d{1,2}(?!\d))(?:[-_. ]{1,3})(?:S|(?:Season|Saison|Series|Stagione)[_. ])?(?<seasonend>(?<!\d)\d{1,2}(?!\d))(?![ex]\d)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Episodes with a title, single (S01E05, 1x05) & multi (S01E05E06, S01E05-06, S01E05 E06)
    private static readonly Regex SeasonEpisodeRegex = new(
        @"^(?<title>.+?)(?:(?:[-_\W](?<![()\[!]))+S?(?<season>(?<!\d)(?:\d{1,2})(?!\d))(?:[ex]|\W[ex]){1,2}(?<episode>\d{2,3}(?!\d))(?:(?:\-|[ex]|\W[ex]|_){1,2}(?<episode>\d{2,3}(?!\d)))*)(?:[-_. ]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // 4-digit season number (S2016E05, 2016x05)
    private static readonly Regex FourDigitSeasonRegex = new(
        @"^(?<title>.+?)(?:(?:[-_\W](?<![()\[!]))+S(?<season>(?<!\d)(?:\d{4})(?!\d))(?:e|\We|_){1,2}(?<episode>\d{2,4}(?!\d))(?:(?:\-|e|\We|_){1,2}(?<episode>\d{2,3}(?!\d)))*)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Full season pack without episodes (Title.S01, Title Season 1)
    private static readonly Regex SeasonPackRegex = new(
        @"^(?<title>.+?)[-_. ]+(?:S(?<season>(?<!\d)\d{1,2}(?!\d))|(?:Season|Saison|Series|Stagione)[_. ](?<season>(?<!\d)\d{1,2}(?!\d)))(?![ex]?\d)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Anime absolute episode with the classic " - NN " fansub delimiter
    private static readonly Regex AnimeAbsoluteDashRegex = new(
        @"^(?:\[(?<subgroup>.+?)\][-_. ]?)?(?<title>.+?)[-_. ]+-[-_. ]+(?<absoluteepisode>\d{2,4})(?:v\d+)?(?:[-_. ]|\(|\[|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Anime "Episode NN"
    private static readonly Regex AnimeEpisodeWordRegex = new(
        @"^(?:\[(?<subgroup>.+?)\][-_. ]?)?(?<title>.+?)[-_. ]+Episode[-_. ]+(?<absoluteepisode>\d{2,4})(?:v\d+)?\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Anime E-prefixed absolute number (Series.E220.720p)
    private static readonly Regex AnimeEPrefixRegex = new(
        @"^(?<title>.+?)[-_. ]+E(?<absoluteepisode>(?<!\d)\d{2,4}(?!\d))(?:v\d+)?(?![-_. ]?[a-z])(?:[-_. ]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Mirrors Sonarr's SimpleTitleRegex: strip format tokens that would otherwise be
    // misread as episode numbers (x264 → "x" + "264", DDP5.1 → season 5, etc).
    private static readonly Regex FormatTokenRegex = new(
        @"\b(?:(?:480|540|576|720|1080|1440|2160)[ip]|[xh][-_. ]?26[45]|HEVC|AVC|AV1|DDP?|E-?AC-?3|EAC3|AC3|AAC|DTS(?:[-_. ]?HD)?(?:[-_. ]?MA)?|TrueHD|FLAC|Atmos|Opus|848x480|1280x720|1920x1080|3840x2160|(?:8|10)bit|10[-_. ]?bit)\b|(?<![A-Za-z0-9])[1-9][.\s][0-4](?![A-Za-z0-9])",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Parses TV numbering; returns null when the name isn't a TV release.</summary>
    public static EpisodeResult? Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var cleaned = ParserNormalization.CleanReleaseName(name);
        cleaned = FormatTokenRegex.Replace(cleaned, " ");

        var daily = DailyRegex.Match(cleaned);
        if (daily.Success)
        {
            var date = $"{daily.Groups["airyear"].Value}-{daily.Groups["airmonth"].Value}-{daily.Groups["airday"].Value}";
            if (DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                return new EpisodeResult
                {
                    Title = CleanTitle(daily.Groups["title"].Value),
                    AirDate = date,
                    IsDaily = true,
                };
            }
        }

        var multiSeason = MultiSeasonRegex.Match(cleaned);
        if (multiSeason.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(multiSeason.Groups["title"].Value),
                Season = ParseInt(multiSeason.Groups["season"].Value),
                SeasonEnd = ParseInt(multiSeason.Groups["seasonend"].Value),
                SeasonPack = true,
            };
        }

        var seasonEpisode = SeasonEpisodeRegex.Match(cleaned);
        if (seasonEpisode.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(seasonEpisode.Groups["title"].Value),
                Season = ParseInt(seasonEpisode.Groups["season"].Value),
                Episodes = CollectInts(seasonEpisode.Groups["episode"]),
            };
        }

        var fourDigit = FourDigitSeasonRegex.Match(cleaned);
        if (fourDigit.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(fourDigit.Groups["title"].Value),
                Season = ParseInt(fourDigit.Groups["season"].Value),
                Episodes = CollectInts(fourDigit.Groups["episode"]),
            };
        }

        var seasonPack = SeasonPackRegex.Match(cleaned);
        if (seasonPack.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(seasonPack.Groups["season"].Index > 0 ? seasonPack.Groups["title"].Value : seasonPack.Groups["title"].Value),
                Season = ParseInt(FirstNonEmpty(seasonPack.Groups["season"])),
                SeasonPack = true,
            };
        }

        // Anime absolute only makes sense with a subgroup or explicit delimiter.
        var animeDash = AnimeAbsoluteDashRegex.Match(cleaned);
        if (animeDash.Success && (animeDash.Groups["subgroup"].Success || StartsWithBracket(cleaned)))
        {
            return new EpisodeResult
            {
                Title = CleanTitle(animeDash.Groups["title"].Value),
                AbsoluteEpisodes = CollectInts(animeDash.Groups["absoluteepisode"]),
                Subgroup = animeDash.Groups["subgroup"].Success ? animeDash.Groups["subgroup"].Value : null,
            };
        }

        var animeWord = AnimeEpisodeWordRegex.Match(cleaned);
        if (animeWord.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(animeWord.Groups["title"].Value),
                AbsoluteEpisodes = CollectInts(animeWord.Groups["absoluteepisode"]),
                Subgroup = animeWord.Groups["subgroup"].Success ? animeWord.Groups["subgroup"].Value : null,
            };
        }

        var animeEPrefix = AnimeEPrefixRegex.Match(cleaned);
        if (animeEPrefix.Success)
        {
            return new EpisodeResult
            {
                Title = CleanTitle(animeEPrefix.Groups["title"].Value),
                AbsoluteEpisodes = CollectInts(animeEPrefix.Groups["absoluteepisode"]),
            };
        }

        return null;
    }

    private static bool StartsWithBracket(string s) => s.StartsWith('[');

    private static string FirstNonEmpty(Group group)
    {
        foreach (Capture capture in group.Captures)
        {
            if (!string.IsNullOrEmpty(capture.Value))
            {
                return capture.Value;
            }
        }

        return group.Value;
    }

    private static IReadOnlyList<int> CollectInts(Group group)
    {
        var list = new List<int>();
        foreach (Capture capture in group.Captures)
        {
            if (int.TryParse(capture.Value, out var value) && !list.Contains(value))
            {
                list.Add(value);
            }
        }

        return list;
    }

    private static int? ParseInt(string value) => int.TryParse(value, out var v) ? v : null;

    private static string CleanTitle(string raw)
    {
        var title = Regex.Replace(raw, @"[._]", " ");
        title = Regex.Replace(title, @"\s+", " ");
        return title.Trim(' ', '-', '_', '.');
    }
}
