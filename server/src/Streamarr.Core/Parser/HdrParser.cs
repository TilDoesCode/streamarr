using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>
/// Parses the HDR flavor (BRIEF §7.1: DV / HDR10+ / HDR10 / HLG / SDR) from a release
/// name. Streamarr-original; the token patterns follow the conventions used by the
/// TRaSH / Radarr custom-format HDR specifications.
/// </summary>
public static class HdrParser
{
    private static readonly Regex DolbyVisionRegex = new(
        @"\b(?:DV|DoVi|Dolby[-_. ]?Vision)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex Hdr10PlusRegex = new(
        @"\bHDR10(?:\+|Plus|P)(?![A-Za-z0-9])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex Hdr10Regex = new(
        @"\b(?:HDR10|HDR)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex HlgRegex = new(
        @"\bHLG\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex SdrRegex = new(
        @"\bSDR\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Every HDR flavor the name indicates, dominant first (e.g. <c>DV</c> + its <c>HDR10</c> base layer).</summary>
    public static IReadOnlyList<string> ParseAll(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return [];
        }

        var formats = new List<string>(3);
        if (DolbyVisionRegex.IsMatch(name))
        {
            formats.Add("DV");
        }

        var hdr10Plus = Hdr10PlusRegex.IsMatch(name);
        if (hdr10Plus)
        {
            formats.Add("HDR10+");
        }
        else if (Hdr10Regex.IsMatch(name))
        {
            formats.Add("HDR10");
        }

        if (HlgRegex.IsMatch(name))
        {
            formats.Add("HLG");
        }

        return formats;
    }

    /// <summary>Returns the dominant HDR flavor, or null when none is indicated.</summary>
    public static string? Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        // Dolby Vision is the headline flavor when present (often paired with an HDR10 fallback layer).
        if (DolbyVisionRegex.IsMatch(name))
        {
            return "DV";
        }

        if (Hdr10PlusRegex.IsMatch(name))
        {
            return "HDR10+";
        }

        if (Hdr10Regex.IsMatch(name))
        {
            return "HDR10";
        }

        if (HlgRegex.IsMatch(name))
        {
            return "HLG";
        }

        if (SdrRegex.IsMatch(name))
        {
            return "SDR";
        }

        return null;
    }
}
