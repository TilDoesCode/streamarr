using System.Text.RegularExpressions;
using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// Evaluates the portable subset of Sonarr/Radarr custom-format specifications against
/// Streamarr's parsed release signals. Conditions of the same implementation are ORed;
/// implementation groups are ANDed, matching Servarr's custom-format behavior.
/// </summary>
public static class CustomFormatMatcher
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(100);

    public static IReadOnlyList<CustomFormatScore> MatchingFormats(
        ReleaseSignals signals,
        QualityProfile profile) => profile.CustomFormats
            .Where(format => Matches(signals, format))
            .ToArray();

    public static int TotalScore(ReleaseSignals signals, QualityProfile profile)
        => MatchingFormats(signals, profile).Sum(format => format.Score);

    private static bool Matches(ReleaseSignals signals, CustomFormatScore format)
    {
        if (format.Conditions.Count == 0)
            return false;

        return format.Conditions
            .GroupBy(condition => Normalize(condition.Implementation), StringComparer.Ordinal)
            .All(group =>
            {
                var results = group.Select(condition => new
                {
                    condition.Required,
                    Matched = ConditionMatches(signals, condition),
                }).ToArray();

                return !results.Any(result => result.Required && !result.Matched) &&
                       results.Any(result => result.Matched);
            });
    }

    private static bool ConditionMatches(ReleaseSignals signals, CustomFormatCondition condition)
    {
        var implementation = Normalize(condition.Implementation);
        if (!CanEvaluate(implementation, condition))
            return false;

        var matched = implementation switch
        {
            "releasetitle" => RegexMatches(condition.Value, signals.ReleaseName),
            "releasegroup" => RegexMatches(condition.Value, signals.ReleaseGroup),
            "edition" => RegexMatches(condition.Value, signals.Edition),
            "resolution" => ListMatches(condition.Value, signals.Resolution),
            "source" => ListMatches(condition.Value, signals.Source),
            "qualitymodifier" => ListMatches(condition.Value, signals.Source),
            "language" => LanguageMatches(signals, condition),
            "size" => SizeMatches(signals.SizeBytes, condition.Min, condition.Max),
            "year" => RangeMatches(signals.Year, condition.Min, condition.Max),
            "releasetype" => ReleaseTypeMatches(signals, condition.Value),
            _ => false,
        };

        return condition.Negate ? !matched : matched;
    }

    private static bool CanEvaluate(string implementation, CustomFormatCondition condition)
        => implementation switch
        {
            "releasetitle" or "releasegroup" or "edition" or "resolution" or "source" or
                "qualitymodifier" => !string.IsNullOrWhiteSpace(condition.Value),
            "language" => !string.IsNullOrWhiteSpace(condition.Value) && condition.Value != "original",
            "size" or "year" => condition.Min is not null && condition.Max is not null,
            "releasetype" => condition.Value is "season-pack" or "multi-episode" or "single-episode",
            _ => false,
        };

    private static bool RegexMatches(string? pattern, string? input)
    {
        if (string.IsNullOrWhiteSpace(pattern) || string.IsNullOrWhiteSpace(input))
            return false;

        try
        {
            return Regex.IsMatch(
                input,
                pattern,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
                RegexTimeout);
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    private static bool ListMatches(string? expected, string? actual)
    {
        if (string.IsNullOrWhiteSpace(expected) || string.IsNullOrWhiteSpace(actual))
            return false;

        return expected.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(value => value.Equals(actual, StringComparison.OrdinalIgnoreCase));
    }

    private static bool LanguageMatches(ReleaseSignals signals, CustomFormatCondition condition)
    {
        if (condition.Value == "*")
            return signals.Languages.Count > 0;
        if (condition.Value == "original" || string.IsNullOrWhiteSpace(condition.Value))
            return false;

        return condition.ExceptLanguage
            ? signals.Languages.Any(language =>
                !language.Equals(condition.Value, StringComparison.OrdinalIgnoreCase))
            : signals.Languages.Any(language =>
                language.Equals(condition.Value, StringComparison.OrdinalIgnoreCase));
    }

    private static bool SizeMatches(long sizeBytes, double? minGb, double? maxGb)
    {
        if (sizeBytes <= 0 || minGb is null || maxGb is null)
            return false;
        var gigabytes = sizeBytes / 1_000_000_000d;
        return gigabytes > minGb && gigabytes <= maxGb;
    }

    private static bool RangeMatches(int? value, double? min, double? max)
        => value is { } number && min is not null && max is not null &&
           number >= min && number <= max;

    private static bool ReleaseTypeMatches(ReleaseSignals signals, string? expected)
        => expected switch
        {
            "season-pack" => signals.SeasonPack,
            "multi-episode" => !signals.SeasonPack && signals.EpisodeCount > 1,
            "single-episode" => !signals.SeasonPack && signals.EpisodeCount == 1,
            _ => false,
        };

    private static string Normalize(string value)
    {
        var normalized = new string(value.Where(char.IsLetterOrDigit)
            .Select(char.ToLowerInvariant)
            .ToArray());
        return normalized.EndsWith("specification", StringComparison.Ordinal)
            ? normalized[..^"specification".Length]
            : normalized;
    }
}
