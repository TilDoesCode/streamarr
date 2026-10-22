using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

/// <summary>How much of a stream session's release payload the server already holds (Usenet articles or a finished pre-download).</summary>
public static class SessionBuffer
{
    /// <summary>Share of the release payload buffered from Usenet; a completed pre-download is 100%.</summary>
    public static double? Percent(ActiveSession active, ArticleMapResponse? articles)
    {
        if (active.PreDownloadCache?.IsComplete == true)
            return 100;
        if (articles is null || articles.TotalExpectedBytes <= 0)
            return null;
        return Math.Min(100, articles.BufferedBytes * 100d / articles.TotalExpectedBytes);
    }

    /// <summary>Buffered payload intervals as fractions, at most <paramref name="maxRanges"/>.</summary>
    public static IReadOnlyList<ByteRangeResponse> Ranges(ActiveSession active, ArticleMapResponse? articles, int maxRanges = 32)
    {
        if (active.PreDownloadCache?.IsComplete == true)
            return [new ByteRangeResponse { Start = 0, End = 1 }];
        return articles is null ? [] : ArticleDownloadTracker.Coarsen(articles.BufferedRanges, maxRanges);
    }
}
