using System.Text.RegularExpressions;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

public sealed record NextEpisodeTarget(
    string WorkId,
    string ReleaseId,
    string Title,
    int SeasonNumber,
    int EpisodeNumber);

/// <summary>Resolves the next canonical TMDB episode and its best currently usable release.</summary>
public sealed partial class NextEpisodeResolver(
    TvCatalogService catalog,
    IReleaseStore releases)
{
    [GeneratedRegex("^tmdb-tv-(?<tmdb>[1-9][0-9]*)-s(?<season>[0-9]+)e(?<episode>[0-9]+)$", RegexOptions.CultureInvariant)]
    private static partial Regex EpisodeWorkIdPattern();

    internal static bool IsCanonicalEpisodeWorkId(string workId)
        => EpisodeWorkIdPattern().IsMatch(workId);

    public Task<NextEpisodeTarget?> ResolveAsync(
        string sourceWorkId,
        CancellationToken cancellationToken)
        => ResolveAsync(
            sourceWorkId,
            sourceReleaseTitle: null,
            preferSimilarRelease: false,
            similarityThreshold: ReleaseSimilarityScorer.DefaultThreshold,
            cancellationToken: cancellationToken);

    public async Task<NextEpisodeTarget?> ResolveAsync(
        string sourceWorkId,
        string? sourceReleaseTitle,
        bool preferSimilarRelease,
        int similarityThreshold,
        CancellationToken cancellationToken)
    {
        if (similarityThreshold is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(similarityThreshold));

        var match = EpisodeWorkIdPattern().Match(sourceWorkId);
        if (!match.Success
            || !int.TryParse(match.Groups["tmdb"].Value, out var tmdbId)
            || !int.TryParse(match.Groups["season"].Value, out var seasonNumber)
            || !int.TryParse(match.Groups["episode"].Value, out var episodeNumber))
        {
            return null;
        }

        var season = await catalog.GetSeasonAsync(
            tmdbId,
            seasonNumber,
            profileId: null,
            cancellationToken).ConfigureAwait(false);
        if (season is null)
            return null;

        var ordered = season.Episodes.OrderBy(episode => episode.EpisodeNumber).ToArray();
        var currentIndex = Array.FindIndex(
            ordered,
            episode => episode.EpisodeNumber == episodeNumber);
        TvEpisodeDto? target = currentIndex >= 0 && currentIndex + 1 < ordered.Length
            ? ordered[currentIndex + 1]
            : null;

        if (target is null)
        {
            var series = await catalog.GetSeriesAsync(tmdbId, cancellationToken).ConfigureAwait(false);
            var nextSeason = series?.Seasons
                .Where(candidate => candidate.SeasonNumber > seasonNumber && candidate.SeasonNumber > 0)
                .OrderBy(candidate => candidate.SeasonNumber)
                .FirstOrDefault();
            if (nextSeason is null)
                return null;

            var nextDetails = await catalog.GetSeasonAsync(
                tmdbId,
                nextSeason.SeasonNumber,
                profileId: null,
                cancellationToken).ConfigureAwait(false);
            target = nextDetails?.Episodes
                .OrderBy(episode => episode.EpisodeNumber)
                .FirstOrDefault();
        }

        if (target is null)
            return null;
        var release = SelectRelease(
            releases.FindUsable(target.WorkId),
            sourceReleaseTitle,
            preferSimilarRelease,
            similarityThreshold);
        if (release is null)
            return null;

        var title = $"{target.SeriesTitle} · S{target.SeasonNumber:D2}E{target.EpisodeNumber:D2} · {target.Title}";
        return new NextEpisodeTarget(
            target.WorkId,
            release.Release.ReleaseId,
            title,
            target.SeasonNumber,
            target.EpisodeNumber);
    }

    internal static RegisteredRelease? SelectRelease(
        IReadOnlyList<RegisteredRelease> candidates,
        string? sourceReleaseTitle,
        bool preferSimilarRelease,
        int similarityThreshold)
    {
        var ranked = candidates
            .OrderByDescending(candidate => candidate.Release.Score)
            .ThenBy(candidate => candidate.Release.Title, StringComparer.OrdinalIgnoreCase)
            .ThenBy(candidate => candidate.Release.Title, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.Release.ReleaseId, StringComparer.Ordinal)
            .ToArray();
        var fallback = ranked.FirstOrDefault();
        if (!preferSimilarRelease || string.IsNullOrWhiteSpace(sourceReleaseTitle))
            return fallback;

        return ranked
                   .Select(candidate => new SimilarityCandidate(
                       candidate,
                       ReleaseSimilarityScorer.Evaluate(sourceReleaseTitle, candidate.Release.Title)))
                   .Where(candidate => candidate.Similarity.Eligible
                                       && candidate.Similarity.Score >= similarityThreshold)
                   .OrderByDescending(candidate => candidate.Similarity.Score)
                   .ThenByDescending(candidate => candidate.Release.Release.Score)
                   .ThenBy(candidate => candidate.Release.Release.Title, StringComparer.OrdinalIgnoreCase)
                   .ThenBy(candidate => candidate.Release.Release.Title, StringComparer.Ordinal)
                   .ThenBy(candidate => candidate.Release.Release.ReleaseId, StringComparer.Ordinal)
                   .Select(candidate => candidate.Release)
                   .FirstOrDefault()
               ?? fallback;
    }

    private sealed record SimilarityCandidate(
        RegisteredRelease Release,
        ReleaseSimilarityResult Similarity);
}
