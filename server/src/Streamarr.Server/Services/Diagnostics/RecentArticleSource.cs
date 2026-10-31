using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>An article a speed test may download: its message-id and size.</summary>
public sealed record RecentArticle(string MessageId, long Bytes);

/// <summary>Where a speed test finds real articles that were streamed lately instead of probing newsgroups.</summary>
public interface IRecentArticleSource
{
    /// <summary>Articles the named provider delivered to recent streams, in the order to try them.</summary>
    IReadOnlyList<RecentArticle> ServedBy(string providerName);

    /// <summary>Segments of the most recently accessed cached NZBs (persistent, survives restarts), in the order to try them.</summary>
    Task<IReadOnlyList<RecentArticle>> FromRecentNzbsAsync(CancellationToken ct);
}

public sealed class RecentArticleSource(
    SessionManager sessions,
    NzbCacheService nzbCache,
    ILogger<RecentArticleSource> logger) : IRecentArticleSource
{
    public const int NzbReleases = 3;
    public const int SegmentsPerRelease = 8;
    public const int MaxServed = 24;
    private const long MinimumBytes = 64 * 1024;
    private const long MaximumBytes = 63L * 1024 * 1024;

    public IReadOnlyList<RecentArticle> ServedBy(string providerName)
    {
        var served = sessions.ArticleTrackers()
            .SelectMany(tracker => tracker.ServedBy(providerName))
            .Where(article => article.Bytes is >= MinimumBytes and <= MaximumBytes)
            .GroupBy(article => article.MessageId, StringComparer.Ordinal)
            .Select(group => group.MaxBy(article => article.At)!)
            .ToList();
        return PreferLargeRecent(served);
    }

    public async Task<IReadOnlyList<RecentArticle>> FromRecentNzbsAsync(CancellationToken ct)
    {
        var perRelease = new List<IReadOnlyList<RecentArticle>>();
        var entries = await nzbCache.ListAsync(ct).ConfigureAwait(false);
        foreach (var entry in entries.Take(NzbReleases))
        {
            try
            {
                if (await nzbCache.GetDocumentAsync(entry.ReleaseId, ct).ConfigureAwait(false) is { } document)
                    perRelease.Add(PickSegments(document, SegmentsPerRelease));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogDebug(e, "Skipping cached NZB {ReleaseId} as speed test source", entry.ReleaseId);
            }
        }
        return Interleave(perRelease);
    }

    /// <summary>Full-size segments only (not file tails), newest first.</summary>
    internal static IReadOnlyList<RecentArticle> PreferLargeRecent(IReadOnlyList<ServedArticle> served)
    {
        if (served.Count == 0)
            return [];
        var largest = served.Max(article => article.Bytes);
        return served
            .Where(article => article.Bytes >= largest * 3 / 4)
            .OrderByDescending(article => article.At)
            .Take(MaxServed)
            .Select(article => new RecentArticle(article.MessageId, article.Bytes))
            .ToList();
    }

    /// <summary>Up to <paramref name="count"/> full-size segments spread evenly over one NZB (not only the start of a file).</summary>
    internal static IReadOnlyList<RecentArticle> PickSegments(NzbDocument document, int count)
    {
        var segments = document.Files
            .SelectMany(file => file.Segments)
            .Where(segment => segment.Bytes is >= MinimumBytes and <= MaximumBytes)
            .ToList();
        if (segments.Count == 0)
            return [];
        var largest = segments.Max(segment => segment.Bytes);
        var full = segments.Where(segment => segment.Bytes >= largest * 3 / 4).ToList();
        var take = Math.Min(count, full.Count);
        return Enumerable.Range(0, take)
            .Select(i => full[(int)((long)i * full.Count / take)])
            .Select(segment => new RecentArticle(segment.MessageId, segment.Bytes))
            .ToList();
    }

    /// <summary>Round-robin over the releases so the newest one does not own every slot.</summary>
    internal static IReadOnlyList<RecentArticle> Interleave(IReadOnlyList<IReadOnlyList<RecentArticle>> releases)
        => Enumerable.Range(0, releases.Count == 0 ? 0 : releases.Max(release => release.Count))
            .SelectMany(i => releases.Where(release => i < release.Count).Select(release => release[i]))
            .ToList();
}
