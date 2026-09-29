using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Subtitle hints a release name gives: generic markers plus the subtitle languages it names.</summary>
public sealed record SubtitleResult
{
    /// <summary>Stable markers: <c>subbed</c> (subtitles mentioned), <c>multi</c> (several languages), <c>hardcoded</c>.</summary>
    public IReadOnlyList<string> Hints { get; init; } = [];

    /// <summary>ISO 639-1 codes of subtitle languages named next to a subtitle marker.</summary>
    public IReadOnlyList<string> Languages { get; init; } = [];
}

/// <summary>Parses subtitle markers (<c>Subbed</c>, <c>MultiSubs</c>, <c>HC</c>, <c>NLSubs</c>, <c>VOSTFR</c> …); empty means unknown, not none.</summary>
public static class SubtitleParser
{
    private static readonly Regex MultiRegex = new(
        @"(?<![A-Za-z])Multi[-_. ]?Sub(?:s|bed|titles?)?(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex HardcodedRegex = new(
        @"(?<![A-Za-z])(?:HC|HCSUBS?|Hard[-_. ]?Sub(?:s|bed)?|Hard[-_. ]?Coded)(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex SubbedRegex = new(
        @"(?<![A-Za-z])(?:Subbed|Subs|Subtitled|Subtitles|VOST[A-Z]{0,2})(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // "NLSubs", "German.Subbed", "Eng.Sub", "SWESUB" (language before the marker) and "Subs.EN" (after).
    private static readonly Regex LanguageBeforeRegex = new(
        @"(?<![A-Za-z])(?<lang>[A-Za-z]{2,7})[-_. ]?Sub(?:s|bed|titles?)?(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex LanguageAfterRegex = new(
        @"(?<![A-Za-z])Sub(?:s|bed|titles?)?[-_. ](?<lang>[A-Za-z]{2,3})(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex VostRegex = new(
        @"(?<![A-Za-z])VOST(?<lang>FR|EN|A)?(?![A-Za-z])",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Dictionary<string, string> LanguageCodes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["en"] = "en", ["eng"] = "en", ["english"] = "en",
        ["de"] = "de", ["ger"] = "de", ["german"] = "de", ["deu"] = "de",
        ["fr"] = "fr", ["fre"] = "fr", ["french"] = "fr", ["fra"] = "fr",
        ["nl"] = "nl", ["dut"] = "nl", ["dutch"] = "nl", ["nld"] = "nl",
        ["es"] = "es", ["spa"] = "es", ["spanish"] = "es",
        ["it"] = "it", ["ita"] = "it", ["italian"] = "it",
        ["sv"] = "sv", ["swe"] = "sv", ["swedish"] = "sv",
        ["da"] = "da", ["dan"] = "da", ["danish"] = "da", ["dk"] = "da",
        ["no"] = "no", ["nor"] = "no", ["norwegian"] = "no",
        ["fi"] = "fi", ["fin"] = "fi", ["finnish"] = "fi",
        ["pl"] = "pl", ["pol"] = "pl", ["polish"] = "pl",
        ["pt"] = "pt", ["por"] = "pt", ["portuguese"] = "pt",
        ["ru"] = "ru", ["rus"] = "ru", ["russian"] = "ru",
        ["ko"] = "ko", ["kor"] = "ko", ["korean"] = "ko",
        ["ja"] = "ja", ["jap"] = "ja", ["jpn"] = "ja", ["japanese"] = "ja",
        ["zh"] = "zh", ["chi"] = "zh", ["chs"] = "zh", ["cht"] = "zh", ["chinese"] = "zh",
        ["ar"] = "ar", ["ara"] = "ar", ["arabic"] = "ar",
        ["tr"] = "tr", ["tur"] = "tr", ["turkish"] = "tr",
        ["he"] = "he", ["heb"] = "he", ["hebrew"] = "he",
        ["cz"] = "cs", ["cze"] = "cs", ["czech"] = "cs",
        ["hu"] = "hu", ["hun"] = "hu", ["hungarian"] = "hu",
        ["gr"] = "el", ["gre"] = "el", ["greek"] = "el",
    };

    public static SubtitleResult Parse(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return new SubtitleResult();
        }

        var hints = new List<string>(3);
        var languages = new List<string>(2);

        foreach (Match match in LanguageBeforeRegex.Matches(name))
        {
            AddLanguage(languages, match.Groups["lang"].Value);
        }

        foreach (Match match in LanguageAfterRegex.Matches(name))
        {
            AddLanguage(languages, match.Groups["lang"].Value);
        }

        var vost = VostRegex.Match(name);
        if (vost.Success)
        {
            AddLanguage(languages, vost.Groups["lang"].Value switch
            {
                "" or "FR" or "fr" => "fr",
                "A" or "a" => "es",
                var other => other,
            });
        }

        var multi = MultiRegex.IsMatch(name);
        if (multi || SubbedRegex.IsMatch(name) || languages.Count > 0)
        {
            hints.Add("subbed");
        }

        if (multi)
        {
            hints.Add("multi");
        }

        if (HardcodedRegex.IsMatch(name))
        {
            hints.Add("hardcoded");
        }

        return new SubtitleResult { Hints = hints, Languages = languages };
    }

    private static void AddLanguage(List<string> languages, string token)
    {
        if (LanguageCodes.TryGetValue(token, out var code) && !languages.Contains(code))
        {
            languages.Add(code);
        }
    }
}
