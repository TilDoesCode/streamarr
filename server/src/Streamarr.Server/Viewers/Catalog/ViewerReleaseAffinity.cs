using Streamarr.Core.Media;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>
/// Continuity across a series: ranker points for releases similar to the one the viewer last played
/// (<see cref="ReleaseSimilarityScorer"/>: group, source, resolution, codecs, languages).
/// </summary>
public static class ViewerReleaseAffinity
{
    /// <summary>Worth a resolution step, never more than a transcode costs (<see cref="ViewerCatalogService.DevicePenalty"/>).</summary>
    public const int Bonus = 40;

    /// <summary>
    /// The bonus for each candidate at least <paramref name="threshold"/> percent similar to <paramref name="lastPlayed"/>;
    /// only candidates in the best viewer language on offer qualify, so a better language always outranks continuity.
    /// </summary>
    public static int[] Points(
        string? lastPlayed, IReadOnlyList<(string Title, int LanguagePoints)> candidates, int threshold = ReleaseSimilarityScorer.DefaultThreshold)
    {
        var points = new int[candidates.Count];
        if (string.IsNullOrWhiteSpace(lastPlayed) || candidates.Count == 0)
            return points;
        var bestLanguage = candidates.Max(c => c.LanguagePoints);
        for (var i = 0; i < candidates.Count; i++)
        {
            if (candidates[i].LanguagePoints != bestLanguage)
                continue;
            var similarity = ReleaseSimilarityScorer.Evaluate(lastPlayed, candidates[i].Title);
            if (similarity.Eligible && similarity.Score >= threshold)
                points[i] = Bonus;
        }
        return points;
    }
}
