// Ported from Radarr / Sonarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Parser/LanguageParser.cs
// Source: Sonarr — src/NzbDrone.Core/Parser/LanguageParser.cs
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// https://github.com/Sonarr/Sonarr  commit f9e18a7c4475345f325237670d7e71ceac97038b
// The LanguageRegex / CaseSensitiveLanguageRegex patterns are reused; the output is
// mapped to ISO 639-1 codes plus multi / dual-audio flags rather than Radarr's
// Language enum. Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>Detected languages and multi / dual-audio flags.</summary>
public sealed record LanguageResult
{
    public IReadOnlyList<string> Languages { get; init; } = [];
    public bool Multi { get; init; }
    public bool DualAudio { get; init; }
}

public static class LanguageParser
{
    private static readonly Regex LanguageRegex = new(@"(?:\W|_|^)(?<english>\beng\b)|
        (?<italian>\b(?:ita|italian)\b)|
        (?<german>(?:swiss)?german\b|videomann|ger[. ]dub|\bger\b)|
        (?<flemish>flemish)|
        (?<bulgarian>bgaudio)|
        (?<romanian>rodubbed)|
        (?<brazilian>\b(dublado|pt-BR)\b)|
        (?<greek>greek)|
        (?<french>\b(?:FR|VO|VF|VFF|VFQ|VFI|VF2|TRUEFRENCH|FRENCH|FRE|FRA)\b)|
        (?<russian>\b(?:rus|ru)\b)|
        (?<hungarian>\b(?:HUNDUB|HUN)\b)|
        (?<hebrew>\b(?:HebDub|HebDubbed)\b)|
        (?<polish>\b(?:PL\W?DUB|DUB\W?PL|LEK\W?PL|PL\W?LEK)\b)|
        (?<chinese>\[(?:CH[ST]|BIG5|GB)\]|简|繁|字幕)|
        (?<ukrainian>(?:(?:\dx)?UKR))|
        (?<spanish>\b(?:español|castellano)\b)|
        (?<catalan>\b(?:catalan?|catalán|català)\b)|
        (?<latvian>\b(?:lat|lav|lv)\b)|
        (?<telugu>\btel\b)|
        (?<vietnamese>\bVIE\b)|
        (?<japanese>\bJAP\b)|
        (?<korean>\bKOR\b)|
        (?<urdu>\burdu\b)|
        (?<original>\b(?:orig|original)\b)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.IgnorePatternWhitespace);

    private static readonly Regex CaseSensitiveLanguageRegex = new(@"(?:(?i)(?<!SUB[\W|_|^]))(?:(?<english>\bEN\b)|
        (?<lithuanian>\bLT\b)|
        (?<czech>\bCZ\b)|
        (?<polish>\bPL\b)|
        (?<bulgarian>\bBG\b)|
        (?<slovak>\bSK\b)|
        (?<german>\bDE\b)|
        (?<spanish>\b(?<!DTS[._ -])ES\b))(?:(?i)(?![\W|_|^]SUB))",
        RegexOptions.Compiled | RegexOptions.IgnorePatternWhitespace);

    private static readonly Regex GermanDualLanguageRegex = new(@"(?<!WEB[-_. ]?)\bDL\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex GermanMultiLanguageRegex = new(@"\bML\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex MultiRegex = new(@"\bMULTI\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex DualAudioRegex = new(@"\bDual[-_. ]?Audio\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Whole-word language names → ISO 639-1.
    private static readonly (string Word, string Code)[] WordLanguages =
    {
        ("english", "en"), ("spanish", "es"), ("danish", "da"), ("dutch", "nl"),
        ("japanese", "ja"), ("icelandic", "is"), ("mandarin", "zh"), ("cantonese", "zh"),
        ("chinese", "zh"), ("korean", "ko"), ("russian", "ru"), ("romanian", "ro"),
        ("hindi", "hi"), ("arabic", "ar"), ("thai", "th"), ("bulgarian", "bg"),
        ("polish", "pl"), ("vietnamese", "vi"), ("swedish", "sv"), ("norwegian", "no"),
        ("finnish", "fi"), ("turkish", "tr"), ("portuguese", "pt"), ("brazilian", "pt"),
        ("hungarian", "hu"), ("hebrew", "he"), ("ukrainian", "uk"), ("persian", "fa"),
        ("bengali", "bn"), ("slovak", "sk"), ("latvian", "lv"), ("tamil", "ta"),
        ("telugu", "te"), ("malayalam", "ml"), ("kannada", "kn"), ("albanian", "sq"),
        ("afrikaans", "af"), ("marathi", "mr"), ("tagalog", "tl"), ("italian", "it"),
        ("german", "de"), ("french", "fr"), ("greek", "el"), ("czech", "cs"),
        ("catalan", "ca"), ("flemish", "nl"),
    };

    public static LanguageResult Parse(string title)
    {
        var languages = new List<string>();
        var lower = title.ToLowerInvariant();

        void Add(string code)
        {
            if (!languages.Contains(code))
            {
                languages.Add(code);
            }
        }

        foreach (var (word, code) in WordLanguages)
        {
            if (lower.Contains(word))
            {
                Add(code);
            }
        }

        foreach (Match match in CaseSensitiveLanguageRegex.Matches(title))
        {
            if (match.Groups["english"].Success)
            {
                Add("en");
            }

            if (match.Groups["lithuanian"].Success)
            {
                Add("lt");
            }

            if (match.Groups["czech"].Success)
            {
                Add("cs");
            }

            if (match.Groups["polish"].Success)
            {
                Add("pl");
            }

            if (match.Groups["bulgarian"].Success)
            {
                Add("bg");
            }

            if (match.Groups["slovak"].Success)
            {
                Add("sk");
            }

            if (match.Groups["german"].Success)
            {
                Add("de");
            }

            if (match.Groups["spanish"].Success)
            {
                Add("es");
            }
        }

        foreach (Match match in LanguageRegex.Matches(title))
        {
            if (match.Groups["english"].Success)
            {
                Add("en");
            }

            if (match.Groups["italian"].Success)
            {
                Add("it");
            }

            if (match.Groups["german"].Success)
            {
                Add("de");
            }

            if (match.Groups["flemish"].Success)
            {
                Add("nl");
            }

            if (match.Groups["greek"].Success)
            {
                Add("el");
            }

            if (match.Groups["french"].Success)
            {
                Add("fr");
            }

            if (match.Groups["russian"].Success)
            {
                Add("ru");
            }

            if (match.Groups["bulgarian"].Success)
            {
                Add("bg");
            }

            if (match.Groups["brazilian"].Success)
            {
                Add("pt");
            }

            if (match.Groups["hungarian"].Success)
            {
                Add("hu");
            }

            if (match.Groups["hebrew"].Success)
            {
                Add("he");
            }

            if (match.Groups["polish"].Success)
            {
                Add("pl");
            }

            if (match.Groups["chinese"].Success)
            {
                Add("zh");
            }

            if (match.Groups["spanish"].Success)
            {
                Add("es");
            }

            if (match.Groups["catalan"].Success)
            {
                Add("ca");
            }

            if (match.Groups["ukrainian"].Success)
            {
                Add("uk");
            }

            if (match.Groups["latvian"].Success)
            {
                Add("lv");
            }

            if (match.Groups["romanian"].Success)
            {
                Add("ro");
            }

            if (match.Groups["telugu"].Success)
            {
                Add("te");
            }

            if (match.Groups["vietnamese"].Success)
            {
                Add("vi");
            }

            if (match.Groups["japanese"].Success)
            {
                Add("ja");
            }

            if (match.Groups["korean"].Success)
            {
                Add("ko");
            }

            if (match.Groups["urdu"].Success)
            {
                Add("ur");
            }
        }

        var multi = MultiRegex.IsMatch(title) || GermanMultiLanguageRegex.IsMatch(title);
        var dual = DualAudioRegex.IsMatch(title);

        // German scene convention: "German DL" = German dual-audio (German + original);
        // "German ML" = German multi (German + original + English).
        if (languages.Contains("de"))
        {
            if (GermanDualLanguageRegex.IsMatch(title))
            {
                dual = true;
            }

            if (GermanMultiLanguageRegex.IsMatch(title))
            {
                Add("en");
            }
        }

        return new LanguageResult
        {
            Languages = languages,
            Multi = multi,
            DualAudio = dual,
        };
    }
}
