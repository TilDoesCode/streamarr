using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class ArticleDownloadTrackerTests
{
    private static readonly DateTimeOffset Start = DateTimeOffset.Parse("2026-08-17T12:00:00Z");

    [Fact]
    public void Snapshot_PreservesManifestOrderAndInitialMetadata()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker("release-1", [
            new ArticleManifestEntry("first@example", "video.mkv", 7, 768_000),
            new ArticleManifestEntry("second@example", "video.mkv", 8, 512_000),
        ], time);

        var snapshot = tracker.Snapshot();

        Assert.Equal("release-1", snapshot.ReleaseId);
        Assert.Equal(2, snapshot.TotalArticles);
        Assert.Equal(2, snapshot.PendingArticles);
        Assert.Equal(0, snapshot.ActiveArticles);
        Assert.Equal(0, snapshot.DownloadedBytes);
        Assert.Null(snapshot.AverageDurationMs);
        Assert.Null(snapshot.EffectiveBytesPerSecond);
        Assert.Equal(Start, snapshot.UpdatedAt);
        Assert.Collection(snapshot.Articles,
            first =>
            {
                Assert.Equal(0, first.Index);
                Assert.Equal("first@example", first.MessageId);
                Assert.Equal("video.mkv", first.FileName);
                Assert.Equal(7, first.ArticleNumber);
                Assert.Equal(768_000, first.ExpectedBytes);
                Assert.Equal("pending", first.State);
                Assert.Empty(first.Attempts);
            },
            second =>
            {
                Assert.Equal(1, second.Index);
                Assert.Equal("second@example", second.MessageId);
                Assert.Equal(8, second.ArticleNumber);
                Assert.Equal(512_000, second.ExpectedBytes);
            });
        Assert.Same(snapshot, tracker.Snapshot());
        tracker.MarkQueued("first@example");
        Assert.NotSame(snapshot, tracker.Snapshot());
    }

    [Fact]
    public void Lifecycle_ReportsActivePartialAndCompletedTransferMetrics()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker("release-1", [
            new ArticleManifestEntry("wire@example", ExpectedBytes: 1_000),
            new ArticleManifestEntry("cache@example", ExpectedBytes: 2_000),
        ], time);

        Assert.True(tracker.MarkQueued("wire@example"));
        var queued = tracker.Snapshot();
        Assert.Equal(1, queued.ActiveArticles);
        Assert.Equal(1, queued.PendingArticles);
        Assert.Equal("queued", queued.Articles[0].State);

        Assert.True(tracker.MarkDownloading("wire@example", "primary"));
        time.Advance(TimeSpan.FromSeconds(2));
        Assert.True(tracker.MarkPartial("wire@example", 400, "primary"));

        var partial = tracker.Snapshot();
        Assert.Equal("partial", partial.Articles[0].State);
        Assert.Equal(0, partial.ActiveArticles);
        Assert.Equal(1, partial.PendingArticles);
        Assert.Equal(1, partial.PartialArticles);
        Assert.Equal(0, partial.DownloadedBytes);
        Assert.Equal(2_000d, partial.Articles[0].DurationMs);
        Assert.Equal(200d, partial.Articles[0].ThroughputBytesPerSecond);
        Assert.Equal(Start.AddSeconds(2), partial.Articles[0].CompletedAt);
        Assert.Null(partial.Articles[0].SuccessfulProvider);

        time.Advance(TimeSpan.FromSeconds(2));
        var unchangedPartial = tracker.Snapshot();
        Assert.Same(partial, unchangedPartial);
        Assert.Equal(2_000d, unchangedPartial.Articles[0].DurationMs);
        Assert.True(tracker.MarkDownloaded("wire@example", 1_000, provider: "primary"));
        Assert.True(tracker.MarkCached("cache@example", provider: "segment cache"));

        var completed = tracker.Snapshot();
        Assert.Equal(1, completed.DownloadedArticles);
        Assert.Equal(1, completed.CachedArticles);
        Assert.Equal(0, completed.PendingArticles);
        Assert.Equal(3_000, completed.DownloadedBytes);
        Assert.Equal(2_000d, completed.AverageDurationMs);
        Assert.Equal(250d, completed.EffectiveBytesPerSecond);

        var downloaded = completed.Articles[0];
        Assert.Equal("downloaded", downloaded.State);
        Assert.Equal(4_000d, downloaded.DurationMs);
        Assert.Equal(250d, downloaded.ThroughputBytesPerSecond);
        Assert.Equal(Start, downloaded.StartedAt);
        Assert.Equal(Start.AddSeconds(4), downloaded.CompletedAt);
        Assert.Equal("primary", downloaded.SuccessfulProvider);

        var cached = completed.Articles[1];
        Assert.Equal("cached", cached.State);
        Assert.Equal(2_000, cached.Bytes);
        Assert.Equal(0d, cached.DurationMs);
        Assert.Equal("segment cache", cached.SuccessfulProvider);

        tracker.MarkCached("wire@example", durationMs: 0, provider: "segment cache");
        var coalesced = tracker.Snapshot().Articles[0];
        Assert.Equal("downloaded", coalesced.State);
        Assert.Equal(4_000d, coalesced.DurationMs);
    }

    [Fact]
    public void ActiveSnapshot_RefreshesElapsedTimeWithoutANewTransferEvent()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry("active@example")],
            time);

        tracker.MarkDownloading("active@example");
        var initial = tracker.Snapshot();
        time.Advance(TimeSpan.FromSeconds(2));

        var refreshed = tracker.Snapshot();

        Assert.NotSame(initial, refreshed);
        Assert.Equal(2_000d, Assert.Single(refreshed.Articles).DurationMs);
        Assert.Same(refreshed, tracker.Snapshot());
    }

    [Fact]
    public void Partial_UsesTerminalDurationAndDoesNotKeepAdvancing()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry("partial@example")],
            time);

        tracker.MarkPartial("partial@example", 500, durationMs: 750);
        var terminal = tracker.Snapshot();
        time.Advance(TimeSpan.FromMinutes(5));
        var later = tracker.Snapshot();

        var article = Assert.Single(later.Articles);
        Assert.Same(terminal, later);
        Assert.Equal(750d, article.DurationMs);
        Assert.Equal(Start.Subtract(TimeSpan.FromMilliseconds(750)), article.StartedAt);
        Assert.Equal(Start, article.CompletedAt);
        Assert.Equal(500, article.Bytes);
        Assert.Equal(500d / .75d, article.ThroughputBytesPerSecond);
    }

    [Fact]
    public void Failure_IsTerminalAndSanitizesDiagnosticText()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker("release-1", [
            new ArticleManifestEntry("failed@example", ExpectedBytes: 1_000),
        ], time);
        var errorType = "bad\r\ntype-" + new string('x', 200);
        var errorMessage = "provider\nsecret\0detail-" + new string('y', 600);

        tracker.MarkDownloading("failed@example", "not-successful");
        time.Advance(TimeSpan.FromMilliseconds(750));
        Assert.True(tracker.MarkFailed(
            "failed@example",
            errorType,
            errorMessage,
            bytes: 125,
            provider: "not-successful"));
        Assert.True(tracker.MarkDownloaded("failed@example", 1_000, provider: "late-success"));

        var snapshot = tracker.Snapshot();
        var failed = Assert.Single(snapshot.Articles);
        Assert.Equal("failed", failed.State);
        Assert.Equal(1, snapshot.FailedArticles);
        Assert.Equal(0, snapshot.DownloadedArticles);
        Assert.Equal(125, failed.Bytes);
        Assert.Equal(750d, failed.DurationMs);
        Assert.Null(failed.SuccessfulProvider);
        Assert.NotNull(failed.ErrorType);
        Assert.NotNull(failed.ErrorMessage);
        Assert.True(failed.ErrorType.Length <= 128);
        Assert.True(failed.ErrorMessage.Length <= 512);
        Assert.DoesNotContain('\r', failed.ErrorType);
        Assert.DoesNotContain('\n', failed.ErrorType);
        Assert.DoesNotContain('\0', failed.ErrorMessage);
        Assert.Equal(Start.AddMilliseconds(750), failed.CompletedAt);
    }

    [Fact]
    public void ProviderAttempts_AreBoundedAndProduceProviderSummaries()
    {
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry("article@example")],
            new ManualTimeProvider(Start),
            maxAttemptsPerArticle: 2);

        Assert.True(tracker.RecordProviderAttempts("article@example", "BODY\n", [
            new NntpProviderAttempt("Primary", "not_found", 10, 430, "nntp_430", "missing\narticle"),
            new NntpProviderAttempt("Backup", "failure", 20, ErrorType: "timeout"),
            new NntpProviderAttempt("Tertiary", "retrieved", 30, 222),
        ]));

        var snapshot = tracker.Snapshot();
        var article = Assert.Single(snapshot.Articles);
        Assert.Equal("Tertiary", article.SuccessfulProvider);
        Assert.Equal(3, article.ProviderAttemptCount);
        Assert.True(article.AttemptsTruncated);
        Assert.Collection(article.Attempts,
            backup =>
            {
                Assert.Equal("Backup", backup.Provider);
                Assert.Equal("BODY", backup.Operation);
                Assert.Equal("error", backup.Outcome);
                Assert.Equal("timeout", backup.ErrorType);
            },
            tertiary =>
            {
                Assert.Equal("Tertiary", tertiary.Provider);
                Assert.Equal("success", tertiary.Outcome);
                Assert.Equal(222, tertiary.ResponseCode);
            });

        Assert.Equal(3, snapshot.Providers.Count);
        var primary = Assert.Single(snapshot.Providers, provider => provider.Provider == "Primary");
        Assert.Equal(0, primary.Successes);
        Assert.Equal(1, primary.Missing);
        Assert.Equal(0, primary.Errors);
        Assert.Equal(10d, primary.AverageDurationMs);
        var backup = Assert.Single(snapshot.Providers, provider => provider.Provider == "Backup");
        Assert.Equal(1, backup.Errors);
        var tertiary = Assert.Single(snapshot.Providers, provider => provider.Provider == "Tertiary");
        Assert.Equal(1, tertiary.Successes);
    }

    [Fact]
    public void FailedOrPartialArticle_CanStartAFreshQueuedAttempt()
    {
        var time = new ManualTimeProvider(Start);
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry("retry@example", ExpectedBytes: 1_000)],
            time);

        tracker.MarkDownloading("retry@example");
        tracker.MarkFailed("retry@example", "timeout", "first attempt timed out", bytes: 100);
        tracker.MarkQueued("retry@example");
        tracker.MarkDownloading("retry@example");
        time.Advance(TimeSpan.FromMilliseconds(50));
        tracker.MarkDownloaded("retry@example", 1_000, provider: "backup");

        var article = Assert.Single(tracker.Snapshot().Articles);
        Assert.Equal("downloaded", article.State);
        Assert.Equal(1_000, article.Bytes);
        Assert.Equal("backup", article.SuccessfulProvider);
        Assert.Null(article.ErrorType);
        Assert.Null(article.ErrorMessage);
    }

    [Fact]
    public void TrackingLimit_IsReportedWithoutHidingTheManifestSize()
    {
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [
                new ArticleManifestEntry("one@example"),
                new ArticleManifestEntry("two@example"),
                new ArticleManifestEntry("three@example"),
            ],
            new ManualTimeProvider(Start),
            maxTrackedArticles: 2);

        var snapshot = tracker.Snapshot();
        Assert.Equal(3, snapshot.TotalArticles);
        Assert.Equal(2, snapshot.TrackedArticles);
        Assert.Equal(1, snapshot.TruncatedArticles);
        Assert.Equal(2, snapshot.Articles.Count);
    }

    [Fact]
    public void UnknownMessageIds_DoNotGrowOrMutateTheSnapshot()
    {
        var tracker = new ArticleDownloadTracker(
            "release-1",
            [new ArticleManifestEntry("known@example")],
            new ManualTimeProvider(Start));

        Assert.False(tracker.MarkQueued("unknown@example"));
        Assert.False(tracker.MarkDownloading("unknown@example"));
        Assert.False(tracker.MarkCached("unknown@example"));
        Assert.False(tracker.MarkDownloaded("unknown@example", 10));
        Assert.False(tracker.MarkPartial("unknown@example", 5));
        Assert.False(tracker.MarkFailed("unknown@example", "error"));
        Assert.False(tracker.RecordProviderAttempts("unknown@example", "BODY", [
            new NntpProviderAttempt("Primary", "success", 1),
        ]));

        var snapshot = tracker.Snapshot();
        Assert.Equal(1, snapshot.TotalArticles);
        Assert.Equal(1, snapshot.PendingArticles);
        Assert.Empty(snapshot.Providers);
        Assert.Equal("pending", Assert.Single(snapshot.Articles).State);
    }

    [Fact]
    public void ConcurrentUpdates_KeepCountsAttemptsAndProviderAggregatesConsistent()
    {
        const int count = 256;
        var entries = Enumerable.Range(0, count)
            .Select(index => new ArticleManifestEntry($"article-{index}@example", ExpectedBytes: 1_000))
            .ToArray();
        var tracker = new ArticleDownloadTracker("release-1", entries, new ManualTimeProvider(Start));

        Parallel.For(0, count, index =>
        {
            var messageId = $"article-{index}@example";
            tracker.MarkQueued(messageId);
            tracker.MarkDownloading(messageId);
            tracker.MarkPartial(messageId, 500);
            tracker.RecordProviderAttempts(messageId, "BODY", [
                new NntpProviderAttempt("Primary", "success", 25, 222),
            ]);
            tracker.MarkDownloaded(messageId, 1_000, durationMs: 25, provider: "Primary");
        });

        var snapshot = tracker.Snapshot();
        Assert.Equal(count, snapshot.TotalArticles);
        Assert.Equal(count, snapshot.DownloadedArticles);
        Assert.Equal(0, snapshot.PendingArticles);
        Assert.Equal(0, snapshot.ActiveArticles);
        Assert.Equal(count * 1_000L, snapshot.DownloadedBytes);
        Assert.All(snapshot.Articles, article =>
        {
            Assert.Equal("downloaded", article.State);
            Assert.Single(article.Attempts);
        });
        var provider = Assert.Single(snapshot.Providers);
        Assert.Equal("Primary", provider.Provider);
        Assert.Equal(count, provider.Successes);
        Assert.Equal(0, provider.Errors);
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
