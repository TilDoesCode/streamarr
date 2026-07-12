// Ported from Radarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Parser/ParserCommon.cs and Parser.cs cleanup helpers
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Shared cleanup passes used to strip site prefixes, torrent suffixes and file extensions.</summary>
internal static class ParserNormalization
{
    // Valid TLDs http://data.iana.org/TLD/tlds-alpha-by-domain.txt
    internal static readonly RegexReplace WebsitePrefixRegex = new(
        @"^(?:(?:\[|\()\s*)?(?:www\.)?[-a-z0-9-]{1,256}\.(?<!Naruto-Kun\.)(?:[a-z]{2,6}\.[a-z]{2,6}|xn--[a-z0-9-]{4,}|[a-z]{2,})\b(?:\s*(?:\]|\))|[ -]{2,})[ -]*",
        string.Empty,
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static readonly RegexReplace CleanTorrentSuffixRegex = new(
        @"\[(?:ettv|rartv|rarbg|cttv|publichd)\]$",
        string.Empty,
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex FileExtensionRegex = new(
        @"\.[a-z0-9]{2,4}$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly HashSet<string> KnownExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv", ".mp4", ".avi", ".m4v", ".mpg", ".mpeg", ".ts", ".wmv", ".mov", ".flv",
        ".webm", ".m2ts", ".iso", ".nzb", ".nfo", ".srt", ".sub", ".idx",
    };

    internal static string RemoveFileExtension(string title)
    {
        var match = FileExtensionRegex.Match(title);
        if (match.Success && KnownExtensions.Contains(match.Value))
        {
            return title[..match.Index];
        }

        return title;
    }

    internal static string CleanReleaseName(string title)
    {
        title = title.Trim();
        title = RemoveFileExtension(title);
        title = WebsitePrefixRegex.Replace(title);
        title = CleanTorrentSuffixRegex.Replace(title);
        return title.Trim();
    }
}
