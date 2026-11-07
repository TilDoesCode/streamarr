using System.Text.RegularExpressions;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>How close a release is to the one the viewer last played (or a download anchor), best last.</summary>
public enum AffinityGrade
{
    None,
    Group,
    Variant,
    Release,
}

/// <summary>
/// Continuity across a series: ranker points for releases like the one the viewer last played
/// (<see cref="ReleaseSimilarityScorer"/>: group, source, resolution, codecs, languages), graded by how close they are.
/// </summary>
public static partial class ViewerReleaseAffinity
{
    /// <summary>The same release apart from the episode numbering (another copy of the pack, the group's next episode); never more than a transcode costs (<see cref="ViewerCatalogService.DevicePenalty"/>).</summary>
    public const int Bonus = 40;

    /// <summary>A similar release (same group) with the same resolution and HDR.</summary>
    public const int VariantBonus = 30;

    /// <summary>A similar release in another resolution or HDR format: continuity, but less than the better picture is worth.</summary>
    public const int GroupBonus = 15;

    /// <summary>
    /// The points for each candidate at least <paramref name="threshold"/> percent similar to <paramref name="lastPlayed"/>;
    /// only candidates in the best viewer language on offer qualify, so a better language always outranks continuity.
    /// </summary>
    public static int[] Points(
        string? lastPlayed, IReadOnlyList<(string Title, int LanguagePoints)> candidates, int threshold = ReleaseSimilarityScorer.DefaultThreshold)
        => Grades(lastPlayed, candidates, threshold).Select(g => g.Points).ToArray();

    /// <summary>
    /// Each candidate's grade against <paramref name="lastPlayed"/> (<see cref="Points"/> are its ranker points) and its similarity score
    /// (100 for the same release); candidates outside the best viewer language on offer get <see cref="AffinityGrade.None"/> and
    /// <c>LanguageGated</c> when they would have matched.
    /// </summary>
    public static (int Points, AffinityGrade Grade, double Score, bool LanguageGated)[] Grades(
        string? lastPlayed, IReadOnlyList<(string Title, int LanguagePoints)> candidates, int threshold = ReleaseSimilarityScorer.DefaultThreshold)
    {
        var grades = new (int Points, AffinityGrade Grade, double Score, bool LanguageGated)[candidates.Count];
        if (string.IsNullOrWhiteSpace(lastPlayed) || candidates.Count == 0)
            return grades;
        var bestLanguage = candidates.Max(c => c.LanguagePoints);
        var last = ReleaseParser.Parse(lastPlayed);
        var lastIdentity = Identity(lastPlayed);
        for (var i = 0; i < candidates.Count; i++)
        {
            var (grade, score) = Grade(lastPlayed, last, lastIdentity, candidates[i].Title, threshold);
            if (candidates[i].LanguagePoints != bestLanguage)
            {
                grades[i] = (0, AffinityGrade.None, score, grade != AffinityGrade.None);
                continue;
            }
            grades[i] = (grade switch { AffinityGrade.Release => Bonus, AffinityGrade.Variant => VariantBonus, AffinityGrade.Group => GroupBonus, _ => 0 },
                grade, score, false);
        }
        return grades;
    }

    private static (AffinityGrade Grade, double Score) Grade(string lastPlayed, ParsedReleaseInfo last, string lastIdentity, string candidate, int threshold)
    {
        if (Identity(candidate) == lastIdentity)
            return (AffinityGrade.Release, 100);
        var similarity = ReleaseSimilarityScorer.Evaluate(lastPlayed, candidate);
        if (!similarity.Eligible || similarity.Score < threshold)
            return (AffinityGrade.None, similarity.Score);
        return (SamePicture(last, ReleaseParser.Parse(candidate)) ? AffinityGrade.Variant : AffinityGrade.Group, similarity.Score);
    }

    private static bool SamePicture(ParsedReleaseInfo a, ParsedReleaseInfo b)
        => string.Equals(a.Resolution, b.Resolution, StringComparison.OrdinalIgnoreCase)
           && string.Equals(a.HdrFormats.FirstOrDefault(), b.HdrFormats.FirstOrDefault(), StringComparison.OrdinalIgnoreCase);

    /// <summary>The name without episode numbering and punctuation: a season pack and its episodes of one release share it.</summary>
    internal static string Identity(string title)
        => string.Join(' ', WordPattern().Matches(EpisodePattern().Replace(title.ToLowerInvariant(), " ")).Select(m => m.Value));

    [GeneratedRegex(@"(?<![a-z0-9])(?:s\d{1,3}(?:[ ._-]?e\d{1,4}(?:[-e]+\d{1,4})*)?|\d{1,3}x\d{1,4})(?![a-z0-9])", RegexOptions.CultureInvariant)]
    private static partial Regex EpisodePattern();

    [GeneratedRegex(@"[\p{L}\p{Nd}]+", RegexOptions.CultureInvariant)]
    private static partial Regex WordPattern();
}
