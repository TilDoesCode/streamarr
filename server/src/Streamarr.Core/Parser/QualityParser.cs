// Ported from Radarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Parser/QualityParser.cs and Parser.cs (EditionRegex)
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// Regexes are reused verbatim; the surrounding logic is adapted to emit Streamarr's
// decomposed QualityResult (resolution / source / codec / edition / revision) rather
// than Radarr's combined Quality enum. Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Decomposed video-quality attributes parsed from a release name.</summary>
public sealed record QualityResult
{
    public string? Resolution { get; init; }
    public string? Source { get; init; }
    public string? VideoCodec { get; init; }
    public string? Edition { get; init; }
    public bool Proper { get; init; }
    public bool Repack { get; init; }
    public int Version { get; init; } = 1;
}

/// <summary>
/// Parses resolution, source, video codec, edition and PROPER/REPACK from a release
/// name. The regexes are ported directly from Radarr's <c>QualityParser</c>.
/// </summary>
public static class QualityParser
{
    private static readonly Regex SourceRegex = new(@"\b(?:
        (?<bluray>M?Blu[-_. ]?Ray|HD[-_. ]?DVD|BD(?!$)|UHD2?BD|BDISO|BDMux|BD25|BD50|BR[-_. ]?DISK)|
        (?<webdl>WEB[-_. ]?DL(?:mux)?|AmazonHD|AmazonSD|iTunesHD|MaxdomeHD|NetflixU?HD|WebHD|HBOMaxHD|DisneyHD|[. ]WEB[. ](?:[xh][ .]?26[45]|AVC|HEVC|DDP?5[. ]1)|[. ](?-i:WEB)$|(?:\d{3,4}0p)[-. ](?:Hybrid[-_. ]?)?WEB[-. ]|[-. ]WEB[-. ]\d{3,4}0p|\b\s\/\sWEB\s\/\s\b|(?:AMZN|NF|DP)[. -]WEB[. -](?!Rip))|
        (?<webrip>WebRip|Web-Rip|WEBMux)|
        (?<hdtv>HDTV)|
        (?<bdrip>BDRip|BDLight|HD[-_. ]?DVDRip|UHDBDRip)|
        (?<brrip>BRRip)|
        (?<dvdr>\d?x?M?DVD-?[R59])|
        (?<dvd>DVD(?!-R)|DVDRip|xvidvd)|
        (?<dsr>WS[-_. ]DSR|DSR)|
        (?<regional>R[0-9]{1}|REGIONAL)|
        (?<scr>SCR|SCREENER|DVDSCR|DVDSCREENER)|
        (?<ts>TS[-_. ]|TELESYNCH?|HD-TS|HDTS|PDVD|TSRip|HDTSRip)|
        (?<tc>TC|TELECINE|HD-TC|HDTC)|
        (?<cam>CAMRIP|(?:NEW)?CAM|HD-?CAM(?:Rip)?|HQCAM)|
        (?<wp>WORKPRINT|WP)|
        (?<pdtv>PDTV)|
        (?<sdtv>SDTV)|
        (?<tvrip>TVRip)
        )(?:\b|$|[ .])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.IgnorePatternWhitespace);

    private static readonly Regex ResolutionRegex = new(
        @"\b(?:(?<R360p>360p)|(?<R480p>480p|480i|640x480|848x480)|(?<R540p>540p)|(?<R576p>576p)|(?<R720p>720p|1280x720|960p)|(?<R1080p>1080p|1920x1080|1440p|FHD|1080i|4kto1080p)|(?<R2160p>2160p|3840x2160|4k[-_. ](?:UHD|HEVC|BD|H\.?265)|(?:UHD|HEVC|BD|H\.?265)[-_. ]4k))\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex AlternativeResolutionRegex = new(
        @"\b(?<R2160p>UHD)\b|(?<R2160p>\[4K\])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex RemuxRegex = new(
        @"(?:[_. \[]|\d{4}p-|\bHybrid-)(?<remux>(?:(BD|UHD)[-_. ]?)?Remux)\b|(?<remux>(?:(BD|UHD)[-_. ]?)?Remux[_. ]\d{4}p)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Video codec detection — extends Radarr's CodecRegex with x265/HEVC/AV1/VC-1/MPEG-2.
    private static readonly Regex CodecRegex = new(
        @"\b(?:(?<x265>x[-_. ]?265|h[-_. ]?265|hevc)|(?<x264>x[-_. ]?264|h[-_. ]?264|avc)|(?<av1>av1)|(?<xvid>xvid(?:hd)?)|(?<divx>divx)|(?<vc1>vc[-_. ]?1)|(?<mpeg2>mpeg[-_. ]?2))\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex ProperRegex = new(@"\b(?<proper>proper)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex RepackRegex = new(@"\b(?<repack>repack\d?|rerip\d?)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex VersionRegex = new(
        @"\d[-._ ]?v(?<version>\d)[-._ ]|\[v(?<version>\d)\]|repack(?<version>\d)|rerip(?<version>\d)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Ported from Radarr Parser.cs EditionRegex.
    private static readonly Regex EditionRegex = new(
        @"\(?\b(?<edition>(((Recut.|Extended.|Ultimate.)?(Director.?s|Collector.?s|Theatrical|Ultimate|Extended|Despecialized|(Special|Rouge|Final|Assembly|Imperial|Diamond|Signature|Hunter|Rekall)(?=(.(Cut|Edition|Version)))|\d{2,3}(th)?.Anniversary)(?:.(Cut|Edition|Version))?(.(Extended|Uncensored|Remastered|Unrated|Uncut|Open.?Matte|IMAX|Fan.?Edit))?|((Uncensored|Remastered|Unrated|Uncut|Open?.Matte|IMAX|Fan.?Edit|Restored|((2|3|4)in1))))))\b\)?",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static QualityResult Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return new QualityResult();
        }

        var normalizedName = name.Replace('_', ' ').Trim();

        var resolution = ParseResolution(normalizedName);
        var source = ParseSource(normalizedName, resolution);
        var codec = ParseCodec(normalizedName);
        var edition = ParseEdition(normalizedName);
        var (proper, repack, version) = ParseRevision(normalizedName);

        return new QualityResult
        {
            Resolution = resolution,
            Source = source,
            VideoCodec = codec,
            Edition = edition,
            Proper = proper,
            Repack = repack,
            Version = version,
        };
    }

    private static string? ParseResolution(string name)
    {
        var match = ResolutionRegex.Match(name);
        var alt = AlternativeResolutionRegex.Match(name);

        if (!match.Success && !alt.Success)
        {
            return null;
        }

        if (match.Groups["R360p"].Success)
        {
            return "360p";
        }

        if (match.Groups["R480p"].Success)
        {
            return "480p";
        }

        if (match.Groups["R540p"].Success)
        {
            return "540p";
        }

        if (match.Groups["R576p"].Success)
        {
            return "576p";
        }

        if (match.Groups["R720p"].Success)
        {
            return "720p";
        }

        if (match.Groups["R1080p"].Success)
        {
            return "1080p";
        }

        if (match.Groups["R2160p"].Success || alt.Groups["R2160p"].Success)
        {
            return "2160p";
        }

        return null;
    }

    private static string? ParseSource(string name, string? resolution)
    {
        var remux = RemuxRegex.IsMatch(name);

        var matches = SourceRegex.Matches(name);
        var match = matches.OfType<Match>().LastOrDefault(m => m.Success);

        if (match == null)
        {
            // Remux without an explicit source is BluRay-tier.
            return remux ? "Remux" : SdFallback(resolution, name);
        }

        if (match.Groups["bluray"].Success)
        {
            return remux ? "Remux" : "BluRay";
        }

        if (match.Groups["webdl"].Success)
        {
            return "WEB-DL";
        }

        if (match.Groups["webrip"].Success)
        {
            return "WEBRip";
        }

        if (match.Groups["hdtv"].Success)
        {
            return "HDTV";
        }

        if (match.Groups["bdrip"].Success)
        {
            return "BDRip";
        }

        if (match.Groups["brrip"].Success)
        {
            return "BRRip";
        }

        if (match.Groups["scr"].Success)
        {
            return "SCR";
        }

        if (match.Groups["cam"].Success)
        {
            return "CAM";
        }

        if (match.Groups["ts"].Success)
        {
            return "TS";
        }

        if (match.Groups["tc"].Success)
        {
            return "TC";
        }

        if (match.Groups["wp"].Success)
        {
            return "WORKPRINT";
        }

        if (match.Groups["dvdr"].Success)
        {
            return "DVDR";
        }

        if (match.Groups["dvd"].Success)
        {
            return "DVD";
        }

        if (match.Groups["pdtv"].Success)
        {
            return "PDTV";
        }

        if (match.Groups["sdtv"].Success)
        {
            return "SDTV";
        }

        if (match.Groups["tvrip"].Success)
        {
            return "TVRip";
        }

        if (match.Groups["dsr"].Success)
        {
            return "DSR";
        }

        if (match.Groups["regional"].Success)
        {
            return "REGIONAL";
        }

        return remux ? "Remux" : SdFallback(resolution, name);
    }

    private static string? SdFallback(string? resolution, string name) => null;

    private static string? ParseCodec(string name)
    {
        var match = CodecRegex.Match(name);
        if (!match.Success)
        {
            return null;
        }

        if (match.Groups["x265"].Success)
        {
            return "x265";
        }

        if (match.Groups["x264"].Success)
        {
            return "x264";
        }

        if (match.Groups["av1"].Success)
        {
            return "AV1";
        }

        if (match.Groups["xvid"].Success)
        {
            return "XviD";
        }

        if (match.Groups["divx"].Success)
        {
            return "DivX";
        }

        if (match.Groups["vc1"].Success)
        {
            return "VC-1";
        }

        if (match.Groups["mpeg2"].Success)
        {
            return "MPEG-2";
        }

        return null;
    }

    private static string? ParseEdition(string name)
    {
        var match = EditionRegex.Match(name);
        if (!match.Success)
        {
            return null;
        }

        var edition = match.Groups["edition"].Value;
        edition = Regex.Replace(edition, @"[._]", " ").Trim();
        edition = Regex.Replace(edition, @"\s+", " ");

        // Title-case-ish tidy: keep as parsed but drop trailing punctuation.
        return string.IsNullOrWhiteSpace(edition) ? null : edition;
    }

    private static (bool Proper, bool Repack, int Version) ParseRevision(string name)
    {
        var version = 1;
        var versionMatch = VersionRegex.Match(name);
        if (versionMatch.Success)
        {
            version = int.Parse(versionMatch.Groups["version"].Value);
        }

        var proper = ProperRegex.IsMatch(name);
        var repack = RepackRegex.IsMatch(name);

        if (proper || repack)
        {
            version = versionMatch.Success
                ? int.Parse(versionMatch.Groups["version"].Value) + 1
                : 2;
        }

        return (proper, repack, version);
    }
}
