using System.Text;
using System.Text.RegularExpressions;
using Streamarr.Core.Parser;

namespace Streamarr.Core.Media;

public static partial class ReleaseSimilarityScorer
{
    public const int DefaultThreshold = 75;
    public const int MaximumInputLength = 1_024;
    private const int MaximumSignatureTokens = 64;

    private static readonly HashSet<string> AnchorTokens = new(StringComparer.Ordinal)
    {
        "webdl", "webrip", "bluray", "bdrip", "brrip", "remux", "hdtv", "dvdrip", "dvd",
        "cam", "telesync", "telecine", "x264", "x265", "av1", "xvid", "divx", "vc1", "mpeg2",
        "hdr10", "hdr10plus", "dv", "hlg", "sdr", "truehd", "dtshdma", "dtsx", "dts", "ddp",
        "dd", "aac", "flac", "opus", "mp3", "proper", "repack", "multi", "dual", "de", "en",
    };

    private static readonly HashSet<string> IgnoredSignatureTokens = new(StringComparer.Ordinal)
    {
        "mkv", "mp4", "avi", "m4v", "mpg", "mpeg", "ts", "wmv", "mov", "flv", "webm", "m2ts",
        "iso", "nzb", "complete", "season", "episode",
    };

    public static double Score(string? sourceTitle, string? candidateTitle)
        => Evaluate(sourceTitle, candidateTitle).Score;

    public static ReleaseSimilarityResult Evaluate(string? sourceTitle, string? candidateTitle)
    {
        if (string.IsNullOrWhiteSpace(sourceTitle) || string.IsNullOrWhiteSpace(candidateTitle))
            return new ReleaseSimilarityResult(0, Eligible: false);

        var source = Features.Create(Bound(sourceTitle));
        var candidate = Features.Create(Bound(candidateTitle));
        if (ExplicitLanguageMismatch(source.Parsed, candidate.Parsed))
            return new ReleaseSimilarityResult(0, Eligible: false);

        var weightedScore = 0d;
        var totalWeight = 0d;

        var exactGroup = !string.IsNullOrEmpty(source.Group)
                         && string.Equals(source.Group, candidate.Group, StringComparison.Ordinal);
        if (!string.IsNullOrEmpty(source.Group) || !string.IsNullOrEmpty(candidate.Group))
            Add(exactGroup ? 1 : 0, 40);

        if (source.SignatureTokens.Count > 0 || candidate.SignatureTokens.Count > 0)
            Add(Dice(source.SignatureTokens, candidate.SignatureTokens), 25);

        var quality = QualityScore(source.Parsed, candidate.Parsed);
        if (quality.Weight > 0)
            Add(quality.Score, 25);

        var language = LanguageScore(source.Parsed, candidate.Parsed);
        if (language.Weight > 0)
            Add(language.Score, 10);

        if (!exactGroup && MatchingTechnicalEvidence(source, candidate) < 2)
            return new ReleaseSimilarityResult(0, Eligible: true);
        if (totalWeight <= 0)
            return new ReleaseSimilarityResult(0, Eligible: true);

        return new ReleaseSimilarityResult(
            Math.Round(weightedScore * 100 / totalWeight, 2, MidpointRounding.AwayFromZero),
            Eligible: true);

        void Add(double component, double weight)
        {
            weightedScore += Math.Clamp(component, 0, 1) * weight;
            totalWeight += weight;
        }
    }

    private static int MatchingTechnicalEvidence(Features source, Features candidate)
    {
        var matches = 0;
        matches += EqualValue(source.Parsed.Resolution, candidate.Parsed.Resolution) ? 1 : 0;
        matches += EqualValue(source.Parsed.Source, candidate.Parsed.Source) ? 1 : 0;
        matches += EqualValue(source.Parsed.VideoCodec, candidate.Parsed.VideoCodec) ? 1 : 0;
        matches += EqualValue(source.Parsed.Hdr, candidate.Parsed.Hdr) ? 1 : 0;
        matches += EqualValue(source.Parsed.AudioCodec, candidate.Parsed.AudioCodec) ? 1 : 0;
        matches += source.Parsed.Languages.Intersect(candidate.Parsed.Languages, StringComparer.OrdinalIgnoreCase).Any()
            ? 1
            : 0;

        var structured = new HashSet<string>(StringComparer.Ordinal)
        {
            CanonicalValue(source.Parsed.Resolution),
            CanonicalValue(source.Parsed.Source),
            CanonicalValue(source.Parsed.VideoCodec),
            CanonicalValue(source.Parsed.Hdr),
            CanonicalValue(source.Parsed.AudioCodec),
        };
        structured.Remove(string.Empty);
        if (source.SignatureTokens.Intersect(candidate.SignatureTokens).Any(token => !structured.Contains(token)))
            matches++;
        return matches;
    }

    private static ComponentScore QualityScore(ParsedReleaseInfo source, ParsedReleaseInfo candidate)
    {
        var score = 0d;
        var weight = 0d;
        Compare(source.Resolution, candidate.Resolution, 20);
        Compare(source.Source, candidate.Source, 20);
        Compare(source.VideoCodec, candidate.VideoCodec, 15);
        Compare(source.Hdr, candidate.Hdr, 10);
        Compare(source.AudioCodec, candidate.AudioCodec, 10);
        Compare(source.AudioChannels, candidate.AudioChannels, 10);
        Compare(source.Edition, candidate.Edition, 5);
        CompareFlag(source.Atmos, candidate.Atmos, 5);
        CompareRevision(source, candidate, 5);
        return new ComponentScore(weight <= 0 ? 0 : score / weight, weight);

        void Compare(string? left, string? right, double fieldWeight)
        {
            if (string.IsNullOrWhiteSpace(left) && string.IsNullOrWhiteSpace(right))
                return;
            weight += fieldWeight;
            if (EqualValue(left, right))
                score += fieldWeight;
        }

        void CompareFlag(bool left, bool right, double fieldWeight)
        {
            if (!left && !right)
                return;
            weight += fieldWeight;
            if (left == right)
                score += fieldWeight;
        }

        void CompareRevision(ParsedReleaseInfo left, ParsedReleaseInfo right, double fieldWeight)
        {
            if (!left.Proper && !left.Repack && left.Version <= 1
                && !right.Proper && !right.Repack && right.Version <= 1)
            {
                return;
            }
            weight += fieldWeight;
            if (left.Proper == right.Proper && left.Repack == right.Repack && left.Version == right.Version)
                score += fieldWeight;
        }
    }

    private static ComponentScore LanguageScore(ParsedReleaseInfo source, ParsedReleaseInfo candidate)
    {
        var sourceLanguages = source.Languages.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var candidateLanguages = candidate.Languages.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var score = 0d;
        var weight = 0d;

        if (sourceLanguages.Count > 0 || candidateLanguages.Count > 0)
        {
            var union = sourceLanguages.Union(candidateLanguages, StringComparer.OrdinalIgnoreCase).Count();
            var intersection = sourceLanguages.Intersect(candidateLanguages, StringComparer.OrdinalIgnoreCase).Count();
            score += union == 0 ? 0 : 0.7 * intersection / union;
            weight += 0.7;
        }
        CompareFlag(source.MultiLanguage, candidate.MultiLanguage);
        CompareFlag(source.DualAudio, candidate.DualAudio);
        return new ComponentScore(weight <= 0 ? 0 : score / weight, weight);

        void CompareFlag(bool left, bool right)
        {
            if (!left && !right)
                return;
            weight += 0.15;
            if (left == right)
                score += 0.15;
        }
    }

    private static bool ExplicitLanguageMismatch(ParsedReleaseInfo source, ParsedReleaseInfo candidate)
        => source.Languages.Count > 0
           && candidate.Languages.Count > 0
           && !source.Languages.Intersect(candidate.Languages, StringComparer.OrdinalIgnoreCase).Any();

    private static double Dice(IReadOnlySet<string> source, IReadOnlySet<string> candidate)
    {
        if (source.Count == 0 && candidate.Count == 0)
            return 1;
        if (source.Count == 0 || candidate.Count == 0)
            return 0;
        return 2d * source.Intersect(candidate).Count() / (source.Count + candidate.Count);
    }

    private static bool EqualValue(string? source, string? candidate)
    {
        var left = CanonicalValue(source);
        return left.Length > 0
               && string.Equals(left, CanonicalValue(candidate), StringComparison.Ordinal);
    }

    private static string CanonicalValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;
        return CanonicalToken(value);
    }

    private static string CanonicalToken(string value)
    {
        var token = new string(NormalizeUnicode(value)
            .Where(char.IsLetterOrDigit)
            .Select(char.ToLowerInvariant)
            .ToArray());
        return token switch
        {
            "h264" or "avc" => "x264",
            "h265" or "hevc" => "x265",
            "web" => "webdl",
            "webdl" => "webdl",
            "webrip" => "webrip",
            "bluray" => "bluray",
            "hdr" => "hdr10",
            "hdr10plus" => "hdr10plus",
            "dovi" or "dolbyvision" => "dv",
            "ddplus" or "eac3" => "ddp",
            "german" or "ger" or "deutsch" => "de",
            "english" or "eng" => "en",
            _ => token,
        };
    }

    private static string NormalizeForTokens(string title)
    {
        var normalized = NormalizeUnicode(title).ToLowerInvariant();
        normalized = WebDlRegex().Replace(normalized, " webdl ");
        normalized = WebRipRegex().Replace(normalized, " webrip ");
        normalized = BluRayRegex().Replace(normalized, " bluray ");
        normalized = H264Regex().Replace(normalized, " x264 ");
        normalized = H265Regex().Replace(normalized, " x265 ");
        normalized = Hdr10PlusRegex().Replace(normalized, " hdr10plus ");
        normalized = DolbyVisionRegex().Replace(normalized, " dv ");
        normalized = DtsHdMaRegex().Replace(normalized, " dtshdma ");
        normalized = DtsXRegex().Replace(normalized, " dtsx ");
        normalized = DdPlusRegex().Replace(normalized, " ddp ");
        return EpisodeIdentityRegex().Replace(normalized, " ");
    }

    private static IReadOnlySet<string> TechnicalTokens(
        string title,
        ParsedReleaseInfo parsed,
        string group)
    {
        var tokens = TokenRegex().Matches(NormalizeForTokens(title))
            .Select(match => CanonicalToken(match.Value))
            .Where(token => token.Length is > 0 and <= 32)
            .ToArray();
        var anchors = new HashSet<string>(StringComparer.Ordinal)
        {
            CanonicalValue(parsed.Resolution),
            CanonicalValue(parsed.Source),
            CanonicalValue(parsed.VideoCodec),
            CanonicalValue(parsed.Hdr),
            CanonicalValue(parsed.AudioCodec),
            CanonicalValue(parsed.Edition),
        };
        anchors.Remove(string.Empty);
        var first = Array.FindIndex(tokens, token => anchors.Contains(token) || IsAnchor(token));
        if (first < 0)
            return new HashSet<string>(StringComparer.Ordinal);

        var result = new HashSet<string>(StringComparer.Ordinal);
        foreach (var token in tokens.Skip(first))
        {
            if (result.Count >= MaximumSignatureTokens)
                break;
            if (token == group || IgnoredSignatureTokens.Contains(token) || token.All(char.IsDigit))
                continue;
            result.Add(token);
        }
        return result;
    }

    private static bool IsAnchor(string token)
        => AnchorTokens.Contains(token) || ResolutionTokenRegex().IsMatch(token);

    private static string Bound(string title)
    {
        title = title.Trim();
        if (title.Length <= MaximumInputLength)
            return title;
        var half = MaximumInputLength / 2;
        return string.Concat(title.AsSpan(0, half), " ", title.AsSpan(title.Length - half));
    }

    private static string NormalizeUnicode(string value)
    {
        try
        {
            return value.Normalize(NormalizationForm.FormKC);
        }
        catch (ArgumentException)
        {
            return value;
        }
    }

    private sealed record Features(
        ParsedReleaseInfo Parsed,
        string Group,
        IReadOnlySet<string> SignatureTokens)
    {
        public static Features Create(string title)
        {
            var parsed = ReleaseParser.Parse(title);
            var group = CanonicalValue(parsed.ReleaseGroup);
            return new Features(parsed, group, TechnicalTokens(title, parsed, group));
        }
    }

    private readonly record struct ComponentScore(double Score, double Weight);

    [GeneratedRegex(@"\bweb[\s._-]*dl\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WebDlRegex();

    [GeneratedRegex(@"\bweb[\s._-]*rip\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WebRipRegex();

    [GeneratedRegex(@"\bblu[\s._-]*ray\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BluRayRegex();

    [GeneratedRegex(@"\b(?:h[\s._-]*264|x264|avc)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex H264Regex();

    [GeneratedRegex(@"\b(?:h[\s._-]*265|x265|hevc)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex H265Regex();

    [GeneratedRegex(@"\bhdr[\s._-]*10[\s._-]*(?:plus|\+)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Hdr10PlusRegex();

    [GeneratedRegex(@"\b(?:dovi|dolby[\s._-]*vision)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DolbyVisionRegex();

    [GeneratedRegex(@"\bdts[\s._-]*hd[\s._-]*ma\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DtsHdMaRegex();

    [GeneratedRegex(@"\bdts[\s._-]*x\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DtsXRegex();

    [GeneratedRegex(@"\b(?:dd\+|ddplus|e[\s._-]*ac[\s._-]*3)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DdPlusRegex();

    [GeneratedRegex(@"\b(?:s\d{1,3}(?:e\d{1,4}(?:(?:e|-)\d{1,4})*)?|\d{1,3}x\d{1,4}|(?:episode|ep)[\s._-]*\d{1,4}(?:v\d+)?)\b|\b(?:19|20)\d{2}[\s._-]\d{1,2}[\s._-]\d{1,2}\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EpisodeIdentityRegex();

    [GeneratedRegex(@"[\p{L}\p{Nd}]+(?:\.\d+)?", RegexOptions.CultureInvariant)]
    private static partial Regex TokenRegex();

    [GeneratedRegex(@"^\d{3,4}[pi]$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ResolutionTokenRegex();
}

public readonly record struct ReleaseSimilarityResult(double Score, bool Eligible);
