using System.Globalization;
using System.Text;

namespace Streamarr.Core.Search;

/// <summary>How a title answers a typed query; higher is better.</summary>
public enum TitleMatch
{
    None = 0,
    WordPrefix = 1,
    Prefix = 2,
    Exact = 3,
}

/// <summary>Search-as-you-type matching: every query token must start some word of a title (case-, diacritic- and umlaut-insensitive).</summary>
public static class TitleMatcher
{
    /// <summary>The best match of <paramref name="query"/> against any of the names (localized, original, alternative titles).</summary>
    public static TitleMatch Match(string query, IEnumerable<string?> names)
    {
        var tokens = Forms(query);
        if (tokens.Count == 0)
            return TitleMatch.None;
        var best = TitleMatch.None;
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name))
                continue;
            var match = Match(tokens, Forms(name));
            if (match > best)
                best = match;
        }
        return best;
    }

    public static TitleMatch Match(string query, params string?[] names) => Match(query, (IEnumerable<string?>)names);

    private static TitleMatch Match(IReadOnlyList<string[]> query, IReadOnlyList<string[]> words)
    {
        if (words.Count == 0)
            return TitleMatch.None;
        // Each spelling (umlaut folded or transliterated) is compared as a whole; a token may use either.
        for (var spelling = 0; spelling < 2; spelling++)
        {
            var title = string.Join(' ', words.Select(w => w[spelling]));
            var typed = string.Join(' ', query.Select(t => t[spelling]));
            if (title == typed)
                return TitleMatch.Exact;
        }
        for (var spelling = 0; spelling < 2; spelling++)
        {
            var title = string.Join(' ', words.Select(w => w[spelling]));
            if (title.StartsWith(string.Join(' ', query.Select(t => t[spelling])), StringComparison.Ordinal))
                return TitleMatch.Prefix;
        }
        return query.All(token => words.Any(word => token.Any(form => word.Any(w => w.StartsWith(form, StringComparison.Ordinal)))))
            ? TitleMatch.WordPrefix
            : TitleMatch.None;
    }

    /// <summary>Words of a text, each as [diacritics folded (ä -> a, ß -> ss), German transliteration (ä -> ae)]; any non-alphanumeric character separates words.</summary>
    internal static IReadOnlyList<string[]> Forms(string text)
    {
        var words = new List<string[]>();
        var folded = new StringBuilder();
        var transliterated = new StringBuilder();
        foreach (var raw in WellFormed(text).Normalize(NormalizationForm.FormC))
        {
            var c = char.ToLowerInvariant(raw);
            if (!char.IsLetterOrDigit(c))
            {
                Flush();
                continue;
            }
            switch (c)
            {
                case 'ä': folded.Append('a'); transliterated.Append("ae"); break;
                case 'ö': folded.Append('o'); transliterated.Append("oe"); break;
                case 'ü': folded.Append('u'); transliterated.Append("ue"); break;
                case 'ß': folded.Append("ss"); transliterated.Append("ss"); break;
                case 'İ' or 'ı': folded.Append('i'); transliterated.Append('i'); break;
                default:
                    var plain = Fold(c);
                    folded.Append(plain);
                    transliterated.Append(plain);
                    break;
            }
        }
        Flush();
        return words;

        void Flush()
        {
            if (folded.Length > 0)
                words.Add([folded.ToString(), transliterated.ToString()]);
            folded.Clear();
            transliterated.Clear();
        }
    }

    /// <summary>The text with every unpaired surrogate replaced by U+FFFD, so normalisation cannot throw.</summary>
    internal static string WellFormed(string text)
    {
        char[]? fixedText = null;
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                i++;
                continue;
            }
            if (char.IsSurrogate(text[i]))
                (fixedText ??= text.ToCharArray())[i] = '\uFFFD';
        }
        return fixedText is null ? text : new string(fixedText);
    }

    private static string Fold(char c)
    {
        var decomposed = c.ToString().Normalize(NormalizationForm.FormD);
        var kept = decomposed.Where(ch => CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark).ToArray();
        return kept.Length == 0 ? c.ToString() : new string(kept);
    }
}
