using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class SessionManagerPreDownloadTests
{
    [Fact]
    public void NormalAdmission_WhenByteBudgetIsFull_EvictsBackgroundBeforeOlderNormalSession()
    {
        var time = new ManualTimeProvider();
        var manager = CreateManager(cacheSizeMb: 2, maxSessions: 20, time);
        const long fileSize = 800L * 1024;
        var normal = manager.CreateSession("normal-old", "work-old", Media(fileSize), "jellyfin");
        time.Advance(TimeSpan.FromSeconds(1));
        var background = AdmitBackground(manager, "background", "work-background", fileSize);
        time.Advance(TimeSpan.FromSeconds(1));

        var incoming = manager.CreateSession("normal-new", "work-new", Media(fileSize), "jellyfin");

        Assert.True(manager.TryGetSession(normal.Token, out _));
        Assert.False(manager.TryGetSession(background.Token, out _));
        Assert.True(manager.TryGetSession(incoming.Token, out _));
        Assert.Equal(2, manager.ListSessions().Count);
    }

    [Fact]
    public void NormalAdmission_WhenSessionLimitIsFull_EvictsBackgroundBeforeOlderNormalSession()
    {
        var time = new ManualTimeProvider();
        var manager = CreateManager(cacheSizeMb: 100, maxSessions: 2, time);
        var normal = manager.CreateSession("normal-old", "work-old", Media(1024), "jellyfin");
        time.Advance(TimeSpan.FromSeconds(1));
        var background = AdmitBackground(manager, "background", "work-background", 1024);
        time.Advance(TimeSpan.FromSeconds(1));

        var incoming = manager.CreateSession("normal-new", "work-new", Media(1024), "jellyfin");

        Assert.True(manager.TryGetSession(normal.Token, out _));
        Assert.False(manager.TryGetSession(background.Token, out _));
        Assert.True(manager.TryGetSession(incoming.Token, out _));
        Assert.Equal(2, manager.ListSessions().Count);
    }

    [Fact]
    public void ExplicitResolve_ReusesAndPromotesAnImplicitBackgroundSession()
    {
        var manager = CreateManager(cacheSizeMb: 100, maxSessions: 20);
        var background = manager.GetOrCreateOpeningSession(
            "release",
            "work",
            Media(1024),
            status: "ready",
            client: "jellyfin",
            requestedById: "user-1",
            retentionPriority: EphemeralRetentionPriority.Background);
        Assert.True(background.Created);
        Assert.Equal(EphemeralRetentionPriority.Background, background.Session.RetentionPriority);

        var explicitResolve = manager.GetOrCreateOpeningSession(
            "release",
            "work",
            Media(1024),
            status: "ready",
            client: "jellyfin",
            requestedById: "user-1",
            retentionPriority: EphemeralRetentionPriority.Normal);

        Assert.False(explicitResolve.Created);
        Assert.Same(background.Session, explicitResolve.Session);
        Assert.Equal(EphemeralRetentionPriority.Normal, background.Session.RetentionPriority);
    }

    [Fact]
    public void FailedImplicitTargetCleanup_PurgesIdleBackgroundSession()
    {
        var manager = CreateManager(cacheSizeMb: 100, maxSessions: 20);
        var background = AdmitBackground(manager, "background", "work-background", 1024);

        var outcome = manager.PurgeBackgroundSession(background.Token);

        Assert.Equal(PurgeOutcome.Purged, outcome);
        Assert.False(manager.TryGetSession(background.Token, out _));
    }

    [Fact]
    public void FailedImplicitTargetCleanup_DoesNotPurgeSessionPromotedByExplicitPlayback()
    {
        var manager = CreateManager(cacheSizeMb: 100, maxSessions: 20);
        var background = AdmitBackground(manager, "release", "work", 1024);
        var explicitResolve = manager.GetOrCreateOpeningSession(
            "release",
            "work",
            Media(1024),
            status: "ready",
            client: "jellyfin",
            requestedById: "user-1",
            retentionPriority: EphemeralRetentionPriority.Normal);
        Assert.Same(background, explicitResolve.Session);

        var outcome = manager.PurgeBackgroundSession(background.Token);

        Assert.Equal(PurgeOutcome.Streaming, outcome);
        Assert.True(manager.TryGetSession(background.Token, out var retained));
        Assert.Equal(EphemeralRetentionPriority.Normal, retained.RetentionPriority);
    }

    private static ActiveSession AdmitBackground(
        SessionManager manager,
        string releaseId,
        string workId,
        long sizeBytes)
        => manager.GetOrCreateOpeningSession(
            releaseId,
            workId,
            Media(sizeBytes),
            status: "ready",
            client: "jellyfin",
            requestedById: "user-1",
            retentionPriority: EphemeralRetentionPriority.Background).Session;

    private static SessionManager CreateManager(
        int cacheSizeMb,
        int maxSessions,
        TimeProvider? time = null)
        => new(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                SessionTtlSeconds = 300,
                EphemeralCacheSizeMb = cacheSizeMb,
                MaxSessions = maxSessions,
            }),
            NullLogger<SessionManager>.Instance,
            time: time);

    private static ResolvedMediaFile Media(long sizeBytes) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = sizeBytes,
        OpenStream = _ => new MemoryStream(new byte[16]),
    };

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-08-17T12:00:00Z");

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
