using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Parses an explicit video bit depth (<c>10bit</c>, <c>Hi10P</c>, <c>Main10</c> …) from a release name.</summary>
public static class BitDepthParser
{
    private static readonly Regex BitsRegex = new(
        @"(?<![A-Za-z0-9])(?<depth>8|10|12)[-_. ]?bits?(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex TenBitProfileRegex = new(
        @"(?<![A-Za-z0-9])(?:Hi10P?|Main[-_. ]?10)(?![A-Za-z0-9])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>The bit depth the name states, or null when it says nothing.</summary>
    public static int? Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        var bits = BitsRegex.Match(name);
        if (bits.Success)
        {
            return int.Parse(bits.Groups["depth"].Value, System.Globalization.CultureInfo.InvariantCulture);
        }

        return TenBitProfileRegex.IsMatch(name) ? 10 : null;
    }
}
