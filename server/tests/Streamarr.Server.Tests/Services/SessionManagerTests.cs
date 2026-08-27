using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Tests.Services;

public class SessionManagerTests
{
    private static readonly byte[] Payload = Enumerable.Range(0, 4096).Select(i => (byte)i).ToArray();

    private static SessionManager Manager(
        int ttlSeconds = 300,
        int cacheSizeMb = 102_400,
        TimeProvider? time = null,
        IReleaseHealthCache? healthCache = null,
        IStreamHistoryRecorder? historyRecorder = null,
        int articleTelemetryCapacity = 500_000) => new(
        new FakeNntpClient(),
        Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
        {
            SessionTtlSeconds = ttlSeconds,
            EphemeralCacheSizeMb = cacheSizeMb,
            MaxSessions = 200,
        }),
        NullLogger<SessionManager>.Instance,
        articleTelemetryCapacity,
        time: time,
        healthCache: healthCache,
        historyRecorder: historyRecorder);

    private static ResolvedMediaFile MediaFile(long? sizeBytes = null) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = sizeBytes ?? Payload.Length,
        OpenStream = _ => new MemoryStream(Payload),
    };

    private static ResolvedMediaFile MediaFileWithArticles(params string[] messageIds)
        => MediaFile() with
        {
            SegmentIds = messageIds,
            ArticleManifest = messageIds
                .Select((messageId, index) => new ArticleManifestEntry(
                    messageId,
                    "video.mkv",
                    index + 1,
                    1_000))
                .ToArray(),
        };

    [Fact]
    public void CreateSession_IssuesUnguessableUniqueTokens()
    {
        var manager = Manager();
        var tokens = Enumerable.Range(0, 100)
            .Select(_ => manager.CreateSession("rel-1", "work-1", MediaFile(), null).Token)
            .ToList();

        Assert.All(tokens, t => Assert.Equal(48, t.Length)); // 192 bits as lowercase hex
        Assert.Equal(tokens.Count, tokens.Distinct().Count());
    }

    [Fact]
    public async Task GetOrCreateOpeningSession_ReusesSameReleaseForSameRequester()
    {
        var manager = Manager();
        var first = manager.GetOrCreateOpeningSession(
            "rel-1",
            "work-1",
            MediaFile(),
            "ready",
            "jellyfin",
            "user-1",
            "First User");
        var resumed = manager.GetOrCreateOpeningSession(
            "rel-1",
            "work-1",
            MediaFile(),
            "ready",
            "jellyfin",
            "user-1",
            "Renamed User");

        Assert.True(first.Created);
        Assert.False(resumed.Created);
        Assert.Same(first.Session, resumed.Session);
        Assert.Single(manager.ListSessions());

        Assert.True(first.Session.CompleteOpening(null));
        Assert.True(await resumed.Session.WaitUntilReadyAsync(CancellationToken.None));
    }

    [Fact]
    public void GetOrCreateOpeningSession_DoesNotShareAcrossRequesterClientOrWork()
    {
        var manager = Manager();
        var first = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1");
        var otherUser = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-2");
        var otherClient = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "web", "user-1");
        var otherWork = manager.GetOrCreateOpeningSession(
            "rel-1", "work-2", MediaFile(), "ready", "jellyfin", "user-1");

        Assert.All(new[] { first, otherUser, otherClient, otherWork }, admission =>
            Assert.True(admission.Created));
        Assert.Equal(4, manager.ListSessions().Count);
    }

    [Fact]
    public void GetOrCreateOpeningSession_DoesNotReuseWithoutStableRequesterId()
    {
        var manager = Manager();
        var first = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", requestedByName: "Same Name");
        var second = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", requestedByName: "Same Name");

        Assert.True(first.Created);
        Assert.True(second.Created);
        Assert.NotEqual(first.Session.Token, second.Session.Token);
    }

    [Fact]
    public void GetOrCreateOpeningSession_ReplacesClosedCapability()
    {
        var manager = Manager();
        var first = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1");

        Assert.True(manager.CloseSession(first.Session.Token));
        var replacement = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1");

        Assert.True(replacement.Created);
        Assert.NotEqual(first.Session.Token, replacement.Session.Token);
        Assert.Single(manager.ListSessions());
    }

    [Fact]
    public async Task OpenStream_ServesBytes_AndMetersThem()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), "web");

        await using var stream = manager.OpenStream(session);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(Payload, ms.ToArray());
        Assert.Equal(Payload.Length, session.BytesServed);
        Assert.Equal(Payload.Length, session.Session.BytesServed);
    }

    [Fact]
    public async Task OpenStream_RecordsOnlyTheInitialMediaByteAcrossRangeRequests()
    {
        var manager = Manager();
        var timeline = TtffTimeline.Start("rel-1");
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), "web", timeline: timeline);

        await using (var first = manager.OpenStream(session))
            Assert.True(await first.ReadAsync(new byte[1]) > 0);
        await using (var range = manager.OpenStream(session))
            Assert.True(await range.ReadAsync(new byte[1]) > 0);

        Assert.Single(timeline.Snapshot(), span => span.Name == "stream-first-byte");
    }

    [Fact]
    public async Task MissingArticleDuringStreaming_MarksReleaseDeadAndInvalidatesSession()
    {
        var healthCache = new ReleaseHealthCache(TimeSpan.FromMinutes(5));
        var manager = Manager(healthCache: healthCache);
        var media = MediaFile() with
        {
            OpenStream = _ => new MissingArticleStream(),
        };
        var session = manager.GetOrCreateOpeningSession(
            "rel-missing", "work-1", media, "ready", "jellyfin", "user-1").Session;
        var parallelOpening = manager.GetOrCreateOpeningSession(
            "rel-missing", "work-1", media, "ready", "jellyfin", "user-2").Session;

        await using var stream = manager.OpenStream(session);
        await Assert.ThrowsAsync<UsenetArticleNotFoundException>(
            () => stream.ReadAsync(new byte[16].AsMemory()).AsTask());

        Assert.True(healthCache.IsDead("rel-missing"));
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.False(manager.TryGetSession(parallelOpening.Token, out _));
        Assert.Throws<SessionUnavailableException>(() => manager.GetOrCreateOpeningSession(
            "rel-missing", "work-1", media, "ready", "jellyfin", "user-3"));
    }

    [Fact]
    public async Task WrappedYencCorruptionDuringStreaming_MarksReleaseDeadAndInvalidatesSession()
    {
        var healthCache = new ReleaseHealthCache(TimeSpan.FromMinutes(5));
        var manager = Manager(healthCache: healthCache);
        var media = MediaFile() with
        {
            OpenStream = _ => new WrappedYencCorruptionStream(),
        };
        var session = manager.GetOrCreateOpeningSession(
            "rel-corrupt", "work-1", media, "ready", "jellyfin", "user-1").Session;

        await using var stream = manager.OpenStream(session);
        await Assert.ThrowsAsync<IOException>(
            () => stream.ReadAsync(new byte[16].AsMemory()).AsTask());

        Assert.True(healthCache.IsDead("rel-corrupt"));
        Assert.False(manager.TryGetSession(session.Token, out _));
    }

    [Fact]
    public void TryGetSession_UnknownToken_IsFalse()
    {
        Assert.False(Manager().TryGetSession("nope", out _));
    }

    [Fact]
    public async Task CloseSession_TearsDown_AndCutsOffOpenStreams()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);
        await using var stream = manager.OpenStream(session);

        Assert.True(manager.CloseSession(session.Token));
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.False(manager.CloseSession(session.Token)); // idempotent-ish: second close reports missing

        var buffer = new byte[16];
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => stream.ReadAsync(buffer.AsMemory()).AsTask());
    }

    [Fact]
    public async Task ClosedSession_CannotBeReopened_AndDoesNotConsumeStreamCapacity()
    {
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                MaxSessions = 2,
                MaxConcurrentStreams = 1,
            }),
            NullLogger<SessionManager>.Instance);
        var closed = manager.CreateSession("closed", "work", MediaFile(), null);
        var live = manager.CreateSession("live", "work", MediaFile(), null);

        Assert.True(manager.CloseSession(closed.Token));
        Assert.Throws<SessionUnavailableException>(() => manager.OpenStream(closed));

        // A rejected reopen must release the sole process-wide stream permit.
        await using var stream = manager.OpenStream(live);
        Assert.Equal(Payload[0], stream.ReadByte());
    }

    [Fact]
    public void PurgeSession_RemovesAnIdleFile()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        Assert.False(session.IsStreaming);
        Assert.Equal(PurgeOutcome.Purged, manager.PurgeSession(session.Token));
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.Empty(manager.ListSessions());
    }

    [Fact]
    public async Task PurgeSession_RefusesWhileActivelyStreaming()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        await using (var stream = manager.OpenStream(session))
        {
            Assert.True(session.IsStreaming);
            Assert.Equal(PurgeOutcome.Streaming, manager.PurgeSession(session.Token));
            Assert.True(manager.TryGetSession(session.Token, out _));

            // The open stream keeps serving bytes — the refused purge left it untouched.
            Assert.Equal(Payload[0], stream.ReadByte());
        }

        // Once the stream is closed the file is idle again and can be purged.
        Assert.False(session.IsStreaming);
        Assert.Equal(PurgeOutcome.Purged, manager.PurgeSession(session.Token));
        Assert.Empty(manager.ListSessions());
    }

    [Fact]
    public void PurgeSession_UnknownToken_ReportsNotFound()
        => Assert.Equal(PurgeOutcome.NotFound, Manager().PurgeSession("nope"));

    [Fact]
    public void SweepExpired_RemovesSessionsPastTheirHardTtl()
    {
        var time = new ManualTimeProvider();
        var manager = Manager(ttlSeconds: 60, time: time);
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        time.Advance(TimeSpan.FromSeconds(61));
        Assert.Equal(1, manager.SweepExpired());
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.Empty(manager.ListSessions());
    }

    [Fact]
    public void SweepExpired_KeepsLiveSessions()
    {
        var manager = Manager(ttlSeconds: 3600);
        manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        Assert.Equal(0, manager.SweepExpired());
        Assert.Single(manager.ListSessions());
    }

    [Fact]
    public void NewLiveArticleMap_EvictsRetainedMapBeforeTruncatingLiveTelemetry()
    {
        var manager = Manager(articleTelemetryCapacity: 2);
        var retained = manager.CreateSession(
            "old-release",
            "old-work",
            MediaFileWithArticles("old-1@test", "old-2@test"),
            null);
        Assert.True(manager.CloseSession(retained.Token));
        Assert.Equal(2, manager.GetArticleTracker(retained.Token)?.TrackedArticleCount);

        var live = manager.CreateSession(
            "live-release",
            "live-work",
            MediaFileWithArticles("live-1@test", "live-2@test"),
            null);

        Assert.Null(manager.GetArticleTracker(retained.Token));
        Assert.Equal(2, live.ArticleTracker?.TrackedArticleCount);
        Assert.Equal(0, live.ArticleTracker?.Snapshot().TruncatedArticles);
    }

    [Fact]
    public void ExpiredRetainedArticleMap_IsPrunedSafely()
    {
        var time = new ManualTimeProvider();
        var manager = Manager(time: time, articleTelemetryCapacity: 2);
        var retained = manager.CreateSession(
            "old-release",
            "old-work",
            MediaFileWithArticles("old@test"),
            null);
        Assert.True(manager.CloseSession(retained.Token));

        time.Advance(TimeSpan.FromHours(1) + TimeSpan.FromMilliseconds(1));

        Assert.Equal(0, manager.SweepExpired());
        Assert.Null(manager.GetArticleTracker(retained.Token));
    }

    [Fact]
    public async Task AccessChangesLruButDoesNotExtendHardExpiry()
    {
        var time = new ManualTimeProvider();
        var manager = Manager(ttlSeconds: 60, time: time);
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);
        var stream = manager.OpenStream(session);

        time.Advance(TimeSpan.FromSeconds(50));
        Assert.Equal(Payload[0], stream.ReadByte());
        Assert.Equal(time.GetUtcNow(), session.Session.LastAccessedAt);

        time.Advance(TimeSpan.FromSeconds(11));
        Assert.Equal(1, manager.SweepExpired());
        Assert.False(manager.TryGetSession(session.Token, out _));
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => stream.ReadAsync(new byte[1]).AsTask());
        await stream.DisposeAsync();
    }

    [Fact]
    public void ListSessions_ReportsUsage()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), "jellyfin");

        var listed = Assert.Single(manager.ListSessions());
        Assert.Equal(session.Token, listed.Token);
        Assert.Equal("jellyfin", listed.Session.Client);
        Assert.Equal(0, listed.NntpUsage.InFlight);
    }

    [Fact]
    public void ProbedHighBitrateSession_RaisesItsPacingRate()
    {
        const long sizeBytes = 12L * 1024 * 1024 * 1024;
        const double configuredFloor = 6d * 1024 * 1024;
        var manager = Manager();
        var session = manager.CreateSession(
            "high-bitrate",
            "work-1",
            MediaFile(sizeBytes),
            "jellyfin");

        session.SetRunTimeTicks(TimeSpan.FromMinutes(10).Ticks);

        Assert.True(session.GetPacingSustainBytesPerSecond(configuredFloor) > configuredFloor);
    }

    [Fact]
    public async Task ThrowingInnerDispose_DoesNotLeakStreamCapacityLease()
    {
        var options = new StreamarrOptions
        {
            SessionTtlSeconds = 300,
            MaxSessions = 2,
            MaxConcurrentStreams = 1,
        };
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(options),
            NullLogger<SessionManager>.Instance);
        var opens = 0;
        var media = MediaFile() with
        {
            OpenStream = _ => Interlocked.Increment(ref opens) == 1
                ? new ThrowingDisposeStream(Payload)
                : new MemoryStream(Payload),
        };
        var session = manager.CreateSession("rel", "work", media, null);

        var first = manager.OpenStream(session);
        await Assert.ThrowsAsync<IOException>(() => first.DisposeAsync().AsTask());

        // The single permit was released in a finally despite the disposal failure.
        await using var second = manager.OpenStream(session);
        Assert.Equal(Payload[0], second.ReadByte());
    }

    [Fact]
    public void CacheBudget_EvictsTheLeastRecentlyAccessedWholeFile()
    {
        var time = new ManualTimeProvider();
        var manager = Manager(cacheSizeMb: 2, time: time);
        var size = 900L * 1024;
        var first = manager.CreateSession("first", "work", MediaFile(size), null);
        time.Advance(TimeSpan.FromSeconds(1));
        var second = manager.CreateSession("second", "work", MediaFile(size), null);
        time.Advance(TimeSpan.FromSeconds(1));

        using (var firstRead = manager.OpenStream(first))
            Assert.Equal(Payload[0], firstRead.ReadByte());
        time.Advance(TimeSpan.FromSeconds(1));
        var third = manager.CreateSession("third", "work", MediaFile(size), null);

        Assert.True(manager.TryGetSession(first.Token, out _));
        Assert.False(manager.TryGetSession(second.Token, out _));
        Assert.True(manager.TryGetSession(third.Token, out _));
        Assert.Equal(2, manager.ListSessions().Count);
    }

    [Fact]
    public void CacheBudget_AllowsOneOversizedFileToStandAlone()
    {
        var manager = Manager(cacheSizeMb: 1);
        var old = manager.CreateSession("old", "work", MediaFile(512 * 1024), null);
        var oversized = manager.CreateSession("oversized", "work", MediaFile(2 * 1024 * 1024), null);

        Assert.False(manager.TryGetSession(old.Token, out _));
        Assert.True(manager.TryGetSession(oversized.Token, out _));
        Assert.Single(manager.ListSessions());
    }

    [Fact]
    public void GetOrCreateOpeningSession_AttachesStreamAttemptIdAndPropagatesToSession()
    {
        var history = new FakeStreamHistoryRecorder();
        var manager = Manager(historyRecorder: history);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });

        var admission = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1",
            streamAttemptId: attemptId);

        Assert.True(admission.Created);
        Assert.Equal(attemptId, admission.Session.StreamAttemptId);
        Assert.Equal(admission.Session.Token, history.AttachedTokens[attemptId]);
    }

    [Fact]
    public void GetOrCreateOpeningSession_Reuse_FinalizesTheReusingAttemptAsReused()
    {
        var history = new FakeStreamHistoryRecorder();
        var manager = Manager(historyRecorder: history);
        var firstAttempt = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });
        var first = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1",
            streamAttemptId: firstAttempt);

        var secondAttempt = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });
        var second = manager.GetOrCreateOpeningSession(
            "rel-1", "work-1", MediaFile(), "ready", "jellyfin", "user-1",
            streamAttemptId: secondAttempt);

        Assert.True(first.Created);
        Assert.False(second.Created);
        Assert.Same(first.Session, second.Session);
        Assert.Contains(history.Finalized, f =>
            f.AttemptId == secondAttempt
            && f.Finalize.FinalState == "reused"
            && f.Finalize.ResolvedReleaseId == "rel-1"
            && f.Finalize.ResolvedTitle == "video.mkv");
        Assert.DoesNotContain(history.Finalized, f => f.AttemptId == firstAttempt);
    }

    [Fact]
    public void CloseSession_FinalizesHistoryRow()
    {
        var history = new FakeStreamHistoryRecorder();
        var manager = Manager(historyRecorder: history);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null, streamAttemptId: attemptId);

        Assert.True(manager.CloseSession(session.Token));

        Assert.Contains(history.Finalized, f =>
            f.AttemptId == attemptId
            && f.Finalize.FinalState == "closed"
            && f.Finalize.ResolvedReleaseId == "rel-1"
            && f.Finalize.ResolvedTitle == "video.mkv");
    }

    [Fact]
    public void PurgeSession_FinalizesHistoryRow()
    {
        var history = new FakeStreamHistoryRecorder();
        var manager = Manager(historyRecorder: history);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null, streamAttemptId: attemptId);

        Assert.Equal(PurgeOutcome.Purged, manager.PurgeSession(session.Token));

        Assert.Contains(history.Finalized, f => f.AttemptId == attemptId && f.Finalize.FinalState == "purged");
    }

    [Fact]
    public void SweepExpired_FinalizesHistoryRow()
    {
        var history = new FakeStreamHistoryRecorder();
        var time = new ManualTimeProvider();
        var manager = Manager(ttlSeconds: 60, time: time, historyRecorder: history);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "rel-1" });
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null, streamAttemptId: attemptId);

        time.Advance(TimeSpan.FromSeconds(61));
        Assert.Equal(1, manager.SweepExpired());

        Assert.Contains(history.Finalized, f => f.AttemptId == attemptId && f.Finalize.FinalState == "expired");
    }

    [Fact]
    public void EvictLeastRecentlyUsed_FinalizesHistoryRow()
    {
        var history = new FakeStreamHistoryRecorder();
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                MaxSessions = 1,
            }),
            NullLogger<SessionManager>.Instance,
            historyRecorder: history);
        var attemptId = history.BeginAttempt(new StreamAttemptBegin { ReleaseId = "one" });
        manager.CreateSession("one", "work", MediaFile(), null, streamAttemptId: attemptId);
        manager.CreateSession("two", "work", MediaFile(), null);

        Assert.Contains(history.Finalized, f => f.AttemptId == attemptId && f.Finalize.FinalState == "evicted");
    }

    [Fact]
    public void SessionLimit_EvictsLruInsteadOfRejectingNewFile()
    {
        var manager = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                MaxSessions = 1,
            }),
            NullLogger<SessionManager>.Instance);
        manager.CreateSession("one", "work", MediaFile(), null);
        var second = manager.CreateSession("two", "work", MediaFile(), null);

        Assert.Single(manager.ListSessions());
        Assert.True(manager.TryGetSession(second.Token, out _));
    }

    private sealed class ThrowingDisposeStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask DisposeAsync()
            => ValueTask.FromException(new IOException("simulated dispose failure"));
    }

    private sealed class MissingArticleStream : MemoryStream
    {
        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
            => ValueTask.FromException<int>(new UsenetArticleNotFoundException("missing@test"));
    }

    private sealed class WrappedYencCorruptionStream : MemoryStream
    {
        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
            => ValueTask.FromException<int>(new IOException(
                "The decoded article is corrupt.",
                new YencCrcMismatchException("CRC mismatch.")));
    }

    /// <summary>Synchronous, in-memory double of the real channel-backed recorder — no
    /// background consumer or SQLite needed to assert what SessionManager sent it.</summary>
    private sealed class FakeStreamHistoryRecorder : IStreamHistoryRecorder
    {
        private int _count;
        public Dictionary<string, string> AttachedTokens { get; } = new(StringComparer.Ordinal);
        public List<(string? AttemptId, IReadOnlyList<StreamEventWrite> Events)> Appended { get; } = [];
        public List<(string? AttemptId, StreamRecordFinalize Finalize)> Finalized { get; } = [];

        public string BeginAttempt(StreamAttemptBegin begin) => $"attempt-{Interlocked.Increment(ref _count)}";
        public void AttachToken(string attemptId, string sessionToken) => AttachedTokens[attemptId] = sessionToken;
        public void AppendEvents(string? attemptId, IReadOnlyList<StreamEventWrite> events) => Appended.Add((attemptId, events));
        public void Finalize(string? attemptId, StreamRecordFinalize finalize) => Finalized.Add((attemptId, finalize));
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-07-21T12:00:00Z");

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
