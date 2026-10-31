using Streamarr.Server.Services;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Tests.Diagnostics;

public sealed class RecentArticleSourceTests
{
    private static readonly DateTimeOffset Start = DateTimeOffset.Parse("2026-08-17T12:00:00Z");

    private static NzbDocument Document(params (string Name, int Count, long Bytes)[] files)
    {
        var document = new NzbDocument();
        foreach (var (name, count, bytes) in files)
        {
            var file = new NzbFile { Subject = $"\"{name}\" yEnc" };
            for (var i = 1; i <= count; i++)
                file.Segments.Add(new NzbSegment { Number = i, Bytes = bytes, MessageId = $"{name}-{i}@nzb" });
            document.Files.Add(file);
        }
        return document;
    }

    [Fact]
    public void PickSegments_SpreadsOverTheNzb_AndSkipsSmallSegments()
    {
        var document = Document(("movie.mkv", 100, 700_000), ("movie.nfo", 2, 2_000), ("tail.bin", 1, 120_000));

        var picked = RecentArticleSource.PickSegments(document, 8);

        Assert.Equal(8, picked.Count);
        Assert.All(picked, article => Assert.Equal(700_000, article.Bytes));
        Assert.All(picked, article => Assert.StartsWith("movie.mkv-", article.MessageId));
        Assert.Equal(8, picked.Select(article => article.MessageId).Distinct().Count());
        Assert.Contains(picked, article => int.Parse(article.MessageId.Split('-')[1].Split('@')[0]) > 50);
    }

    [Fact]
    public void PickSegments_OfASmallNzb_ReturnsWhatThereIs_AndNothingWithoutUsableSegments()
    {
        Assert.Equal(3, RecentArticleSource.PickSegments(Document(("a.bin", 3, 500_000)), 8).Count);
        Assert.Empty(RecentArticleSource.PickSegments(Document(("a.nfo", 3, 2_000)), 8));
        Assert.Empty(RecentArticleSource.PickSegments(new NzbDocument(), 8));
    }

    [Fact]
    public void Interleave_AlternatesBetweenReleases()
    {
        var picked = RecentArticleSource.Interleave([
            [new("a1", 1), new("a2", 1), new("a3", 1)],
            [new("b1", 1)],
        ]);

        Assert.Equal(["a1", "b1", "a2", "a3"], picked.Select(article => article.MessageId));
    }

    [Fact]
    public void PreferLargeRecent_KeepsFullSizeSegments_NewestFirst()
    {
        var picked = RecentArticleSource.PreferLargeRecent([
            new ServedArticle("old@x", 700_000, Start),
            new ServedArticle("tail@x", 90_000, Start.AddMinutes(9)),
            new ServedArticle("new@x", 690_000, Start.AddMinutes(5)),
        ]);

        Assert.Equal(["new@x", "old@x"], picked.Select(article => article.MessageId));
        Assert.Empty(RecentArticleSource.PreferLargeRecent([]));
    }

    [Fact]
    public void Tracker_ReportsOnlyArticlesTheProviderDelivered()
    {
        var tracker = new ArticleDownloadTracker("release", [
            new ArticleManifestEntry("served@x", ExpectedBytes: 700_000),
            new ArticleManifestEntry("missing@x", ExpectedBytes: 700_000),
            new ArticleManifestEntry("statted@x", ExpectedBytes: 700_000),
            new ArticleManifestEntry("untouched@x", ExpectedBytes: 700_000),
        ], new ManualClock(Start));
        tracker.RecordProviderAttempts("served@x", "BODY", [new NntpProviderAttempt("Main", "success", 12)]);
        tracker.MarkDownloaded("served@x", 690_000, 12, "Main");
        tracker.RecordProviderAttempts("missing@x", "BODY", [new NntpProviderAttempt("Main", "missing", 5, 430), new NntpProviderAttempt("Backup", "success", 9)]);
        tracker.RecordProviderAttempts("statted@x", "STAT", [new NntpProviderAttempt("Main", "success", 3)]);

        var main = tracker.ServedBy("Main");

        var served = Assert.Single(main);
        Assert.Equal("served@x", served.MessageId);
        Assert.Equal(690_000, served.Bytes);
        Assert.Equal("missing@x", Assert.Single(tracker.ServedBy("Backup")).MessageId);
        Assert.Empty(tracker.ServedBy("Other"));
    }
}
