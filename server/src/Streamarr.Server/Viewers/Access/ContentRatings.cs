using System.Globalization;
using System.Text.RegularExpressions;

namespace Streamarr.Server.Viewers.Access;

/// <summary>Maps TMDB certifications (US, FSK, BBFC and numeric national systems) onto a minimum viewer age.</summary>
public static partial class ContentRatings
{
    private static readonly Dictionary<string, int> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["G"] = 0, ["TV-G"] = 0, ["TV-Y"] = 0, ["E"] = 0, ["EC"] = 0, ["U"] = 0, ["UC"] = 0, ["APPROVED"] = 0, ["AL"] = 0, ["L"] = 0, ["ALL"] = 0,
        ["TV-Y7"] = 7, ["TV-Y7-FV"] = 7,
        ["PG"] = 10, ["TV-PG"] = 10,
        ["PG-13"] = 13, ["12A"] = 12,
        ["TV-14"] = 14,
        ["M"] = 15,
        ["R"] = 17, ["TV-MA"] = 17,
        ["NC-17"] = 18, ["X"] = 18, ["XXX"] = 18, ["AO"] = 18, ["R18"] = 18, ["R18+"] = 18, ["X18+"] = 18,
    };

    private static readonly HashSet<string> Unrated = new(StringComparer.OrdinalIgnoreCase) { "NR", "UR", "NOT RATED", "UNRATED", "N/A", "-" };

    [GeneratedRegex(@"^(?:FSK|BBFC|KIJKWIJZER|AB|K|M|R|MA|A|T|B)?[\s\-]?(?<age>\d{1,2})\+?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex NumericPattern();

    /// <summary>The minimum age for a certification, or null when it is unknown or explicitly unrated.</summary>
    public static int? MinimumAge(string? certification)
    {
        var value = certification?.Trim();
        if (string.IsNullOrEmpty(value) || value.Length > 32 || Unrated.Contains(value))
            return null;
        if (Named.TryGetValue(value, out var named))
            return named;
        var match = NumericPattern().Match(value);
        if (match.Success && int.TryParse(match.Groups["age"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var age) && age <= 21)
            return age;
        return null;
    }
}
