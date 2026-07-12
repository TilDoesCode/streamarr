// Movie title/year regexes ported from Radarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Parser/Parser.cs (ReportMovieTitleRegex)
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>
/// Top-level release-name parser (BRIEF §7.1). Combines the quality, HDR, audio,
/// language, release-group and episode parsers into a single <see cref="ParsedReleaseInfo"/>.
/// </summary>
public static class ReleaseParser
{
    // Anime [Subgroup] and Year (Radarr ReportMovieTitleRegex[0]).
    private static readonly Regex AnimeSubgroupYearRegex = new(
        @"^(?:\[(?<subgroup>.+?)\][-_. ]?)(?<title>(?![(\[]).+?)?(?:(?:[-_\W](?<![)\[!]))*(?<year>(1(8|9)|20)\d{2}(?!p|i|x|\d+|\]|\W\d+)))+.*?(?<hash>\[\w{8}\])?(?:$|\.)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Normal movie format, e.g. Mission.Impossible.3.2011 (Radarr ReportMovieTitleRegex normal).
    private static readonly Regex MovieTitleYearRegex = new(
        @"^(?<title>(?![(\[]).+?)?(?:(?:[-_\W](?<![)\[!]))*(?<year>(1(8|9)|20)\d{2}(?!p|i|(1(8|9)|20)\d{2}|\]|\W(1(8|9)|20)\d{2})))+(\W+|_|$)(?!\\)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Fallback: cut the title off at the first quality/format marker.
    private static readonly Regex FirstMarkerRegex = new(
        @"\b(?:2160p|1080p|1080i|720p|576p|540p|480p|360p|BluRay|Blu-Ray|Remux|WEB-?DL|WEB-?Rip|WEB|HDTV|BDRip|BRRip|DVDRip|DVD|HDRip|x264|x265|h264|h265|HEVC|AVC|XviD|AV1|DTS|DDP|DD5|AC3|AAC|TrueHD|UHD|HDR|PROPER|REPACK)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex TitleYearParenRegex = new(
        @"\((?<year>(?:19|20)\d{2})\)",
        RegexOptions.Compiled);

    public static ParsedReleaseInfo Parse(string releaseName)
    {
        ArgumentNullException.ThrowIfNull(releaseName);

        var quality = QualityParser.Parse(releaseName);
        var hdr = HdrParser.Parse(releaseName);
        var audio = AudioParser.Parse(releaseName);
        var languages = LanguageParser.Parse(releaseName);
        var releaseGroup = ReleaseGroupParser.Parse(releaseName);
        var episode = EpisodeParser.Parse(releaseName);

        string? title;
        int? year;
        var mediaType = ParsedMediaType.Unknown;

        if (episode != null)
        {
            mediaType = ParsedMediaType.Tv;
            title = episode.Title;
            year = ExtractYearFromTitle(ref title);
        }
        else
        {
            (title, year) = ParseMovieTitleAndYear(releaseName);
            if (title != null || year != null || quality.Resolution != null || quality.Source != null)
            {
                mediaType = ParsedMediaType.Movie;
            }
        }

        return new ParsedReleaseInfo
        {
            ReleaseName = releaseName,
            Title = title,
            Year = year,
            MediaType = mediaType,
            Resolution = quality.Resolution,
            Source = quality.Source,
            VideoCodec = quality.VideoCodec,
            Hdr = hdr,
            AudioCodec = audio.Codec,
            AudioChannels = audio.Channels,
            Atmos = audio.Atmos,
            ReleaseGroup = releaseGroup,
            Edition = quality.Edition,
            Proper = quality.Proper,
            Repack = quality.Repack,
            Version = quality.Version,
            Languages = languages.Languages,
            MultiLanguage = languages.Multi,
            DualAudio = languages.DualAudio,
            Season = episode?.Season,
            Episodes = episode?.Episodes ?? [],
            AbsoluteEpisodes = episode?.AbsoluteEpisodes ?? [],
            SeasonPack = episode?.SeasonPack ?? false,
            SeasonEnd = episode?.SeasonEnd,
            AirDate = episode?.AirDate,
            IsDaily = episode?.IsDaily ?? false,
        };
    }

    private static (string? Title, int? Year) ParseMovieTitleAndYear(string releaseName)
    {
        var cleaned = ParserNormalization.CleanReleaseName(releaseName);

        var anime = AnimeSubgroupYearRegex.Match(cleaned);
        if (anime.Success && anime.Groups["title"].Success)
        {
            var animeTitle = Normalize(anime.Groups["title"].Value);
            var animeYear = ParseYear(anime.Groups["year"].Value);
            if (!string.IsNullOrWhiteSpace(animeTitle))
            {
                return (animeTitle, animeYear);
            }
        }

        var match = MovieTitleYearRegex.Match(cleaned);
        if (match.Success && match.Groups["title"].Success)
        {
            var title = Normalize(match.Groups["title"].Value);
            var year = ParseYear(LastCapture(match.Groups["year"]));
            if (!string.IsNullOrWhiteSpace(title))
            {
                return (title, year);
            }
        }

        // Fallback: no year — cut at the first quality marker.
        var marker = FirstMarkerRegex.Match(cleaned);
        if (marker.Success && marker.Index > 0)
        {
            var title = Normalize(cleaned[..marker.Index]);
            return (string.IsNullOrWhiteSpace(title) ? null : title, null);
        }

        return (null, null);
    }

    private static int? ExtractYearFromTitle(ref string? title)
    {
        if (title == null)
        {
            return null;
        }

        var match = TitleYearParenRegex.Match(title);
        if (match.Success)
        {
            var year = ParseYear(match.Groups["year"].Value);
            title = Normalize(title[..match.Index]);
            return year;
        }

        return null;
    }

    private static string LastCapture(Group group)
    {
        return group.Captures.Count > 0 ? group.Captures[^1].Value : group.Value;
    }

    private static int? ParseYear(string value) =>
        int.TryParse(value, out var year) && year is >= 1870 and <= 2100 ? year : null;

    private static string Normalize(string raw)
    {
        var title = Regex.Replace(raw, @"[._]", " ");
        title = Regex.Replace(title, @"\s+", " ");
        return title.Trim(' ', '-', '_', '.');
    }
}
