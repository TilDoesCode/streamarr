using Microsoft.Net.Http.Headers;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>The audio languages a viewer's versions are ranked by, best first: sent explicitly, else the app language (Accept-Language), else the profile's own.</summary>
public static class ViewerAudioLanguages
{
    public const int MaxEntries = 4;

    /// <summary>The <c>audioLanguages</c> query value: comma-separated 2–3 letter codes (3-letter ones as their ISO 639-1 code), best first, duplicates dropped, entries after the fourth ignored; null when absent.</summary>
    public static IReadOnlyList<string>? Parse(string? csv)
    {
        if (string.IsNullOrWhiteSpace(csv))
            return null;
        var codes = csv.Length > 64 ? null : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(c => c.ToLowerInvariant())
            .ToList();
        if (codes is null || codes.Any(c => c.Length is < 2 or > 3 || !c.All(char.IsAsciiLetterLower)))
            throw ViewerProblem.BadRequest("invalid_query", "'audioLanguages' must be comma-separated ISO 639-1 language codes (e.g. de,en).");
        var known = codes.Select(Code).OfType<string>().Distinct(StringComparer.Ordinal).Take(MaxEntries).ToList();
        return known.Count == 0 ? null : known;
    }

    /// <summary>The primary tag of the most preferred Accept-Language entry that is a two-letter (ISO 639-1) code; else null.</summary>
    public static string? FromAcceptLanguage(string? acceptLanguage)
    {
        if (string.IsNullOrWhiteSpace(acceptLanguage) || !StringWithQualityHeaderValue.TryParseList([acceptLanguage], out var values))
            return null;
        return values
            .Where(v => (v.Quality ?? 1) > 0)
            .OrderByDescending(v => v.Quality ?? 1)
            .Select(v => TmdbLanguage.Primary(v.Value.Value))
            .FirstOrDefault(code => code is { Length: 2 });
    }

    /// <summary>The requested languages, else the app language, else null (the profile's own preference).</summary>
    public static IReadOnlyList<string>? Resolve(IReadOnlyList<string>? requested, string? appLanguage)
        => requested is { Count: > 0 } ? requested : appLanguage is null ? null : [appLanguage];

    /// <summary>A playback's ranking languages: its preferred audio language, else the app language.</summary>
    public static IReadOnlyList<string>? ForPlayback(string? audioLanguage, string? appLanguage)
        => Resolve(Code(audioLanguage) is { } code ? [code] : null, appLanguage);

    /// <summary>A track or request language as the code release names are parsed to ("ger" → "de"); null for undetermined.</summary>
    private static string? Code(string? language) => WebVttSubtitles.Bcp47(language);

    /// <summary>The ranking profile <paramref name="basis"/> with the viewer's languages; null when they are its own (scores stay as ranked).</summary>
    public static QualityProfile? ProfileFor(IReadOnlyList<string>? languages, QualityProfile basis)
        => languages is null || languages.SequenceEqual(basis.PreferredLanguages, StringComparer.OrdinalIgnoreCase)
            ? null
            : basis with { PreferredLanguages = languages };

    /// <summary>The language points of <paramref name="languages"/> for <paramref name="viewer"/> (null = <paramref name="basis"/>'s own).</summary>
    public static int LanguagePoints(IReadOnlyList<string> languages, QualityProfile? viewer, QualityProfile basis)
        => WeightedSumRanker.LanguagePoints(viewer ?? basis, languages);

    /// <summary>The release's score under <paramref name="basis"/> (<paramref name="score"/>) with its language points re-scored for <paramref name="viewer"/> (see <see cref="ProfileFor"/>).</summary>
    public static int Score(int score, IReadOnlyList<string> languages, QualityProfile? viewer, QualityProfile basis)
        => viewer is null
            ? score
            : score - WeightedSumRanker.LanguagePoints(basis, languages) + WeightedSumRanker.LanguagePoints(viewer, languages);
}
