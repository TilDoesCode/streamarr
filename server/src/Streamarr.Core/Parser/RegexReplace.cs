// Ported from Radarr (GPL-3.0).
// Source: Radarr — src/NzbDrone.Core/Parser/RegexReplace.cs
// https://github.com/Radarr/Radarr  commit c7cf91c14ac42096a013e1bbb1875bd73b6c509f
// Streamarr is GPL-3.0; see LICENSE + NOTICE.
using System.Text.RegularExpressions;

namespace Streamarr.Core.Parser;

/// <summary>A compiled regex paired with a replacement, used by the parser's cleanup passes.</summary>
public sealed class RegexReplace
{
    private readonly Regex _regex;
    private readonly string? _replacementFormat;
    private readonly MatchEvaluator? _replacementFunc;

    public RegexReplace(string pattern, string replacement, RegexOptions regexOptions)
    {
        _regex = new Regex(pattern, regexOptions);
        _replacementFormat = replacement;
    }

    public RegexReplace(string pattern, MatchEvaluator replacement, RegexOptions regexOptions)
    {
        _regex = new Regex(pattern, regexOptions);
        _replacementFunc = replacement;
    }

    public string Replace(string input)
    {
        return _replacementFunc != null
            ? _regex.Replace(input, _replacementFunc)
            : _regex.Replace(input, _replacementFormat!);
    }

    public bool TryReplace(ref string input)
    {
        var result = _regex.IsMatch(input);
        input = _replacementFunc != null
            ? _regex.Replace(input, _replacementFunc)
            : _regex.Replace(input, _replacementFormat!);
        return result;
    }

    public override string ToString() => _regex.ToString();
}
