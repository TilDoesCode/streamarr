using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Services;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>The download priority policy: transfer limits, shared bandwidth below live streams, the connection share and session pinning.</summary>
public sealed class DownloadPriorityTests
{
    private static DownloadTransferGovernor Governor(FakeLiveSignal live, ViewerDownloadSettings? settings = null)
        => new(() => settings ?? new ViewerDownloadSettings(), live);

    [Fact]
    public void Admission_EnforcesPerDownload_PerViewer_AndServerLimits()
    {
        var governor = Governor(new FakeLiveSignal(), new ViewerDownloadSettings { MaxActivePerViewer = 2, MaxActiveGlobal = 3 });

        using var a1 = governor.TryAdmit("a", "anna", null, default, out _);
        using var a2 = governor.TryAdmit("a", "anna", null, default, out _);
        Assert.Null(governor.TryAdmit("a", "anna", null, default, out var perDownload));
        Assert.Equal("download", perDownload);
        using var b = governor.TryAdmit("b", "anna", null, default, out _);
        Assert.Null(governor.TryAdmit("c", "anna", null, default, out var perViewer));
        Assert.Equal("viewer", perViewer);
        Assert.Null(governor.TryAdmit("c", "anna", 1, default, out _));
        using var d = governor.TryAdmit("d", "ben", null, default, out _);
        Assert.Null(governor.TryAdmit("e", "gast", null, default, out var server));
        Assert.Equal("server", server);

        Assert.NotNull(a1);
        Assert.Equal(3, governor.ActiveTransfers);
        b!.Dispose();
        using var e = governor.TryAdmit("e", "gast", null, default, out _);
        Assert.NotNull(e);
    }

    [Fact]
    public void Abort_EndsEveryOpenRequestOfTheDownload()
    {
        var governor = Governor(new FakeLiveSignal());
        using var first = governor.TryAdmit("a", "anna", null, default, out _)!;
        using var second = governor.TryAdmit("a", "anna", null, default, out _)!;
        using var other = governor.TryAdmit("b", "anna", null, default, out _)!;

        governor.Abort("a");

        Assert.True(first.Token.IsCancellationRequested);
        Assert.True(second.Token.IsCancellationRequested);
        Assert.False(other.Token.IsCancellationRequested);
    }

    [Fact]
    public void TheRate_IsUnlimitedWhenIdle_AndCappedWhileALiveStreamPlays()
    {
        var live = new FakeLiveSignal();
        var governor = Governor(live, new ViewerDownloadSettings { BandwidthWhileStreamingKbps = 8_000, BandwidthKbps = 0 });

        Assert.Null(governor.CurrentRate());
        live.LiveStreams = 1;
        Assert.Equal(1_000_000, governor.CurrentRate());
        Assert.True(governor.Throttled);
    }

    [Fact]
    public async Task WhileALiveStreamPlays_AllDownloadsTogether_StayAtTheCap()
    {
        var governor = Governor(new FakeLiveSignal { LiveStreams = 1 }, new ViewerDownloadSettings { BandwidthWhileStreamingKbps = 1_600 });
        const int chunk = 16 * 1024;
        var watch = Stopwatch.StartNew();

        // Two transfers share 200 kB/s: 400 kB beyond the 100 kB burst take at least ~1.5 s.
        await Task.WhenAll(Enumerable.Range(0, 2).Select(async _ =>
        {
            for (var sent = 0; sent < 200_000; sent += chunk)
                await governor.ThrottleAsync(chunk, CancellationToken.None);
        }));

        Assert.InRange(watch.Elapsed.TotalSeconds, 1.4, 5);
    }

    [Fact]
    public async Task ZeroWhileStreaming_PausesDownloads_UntilTheLiveStreamEnds()
    {
        var live = new FakeLiveSignal { LiveStreams = 1 };
        var governor = Governor(live, new ViewerDownloadSettings { BandwidthWhileStreamingKbps = 0 });

        var paused = governor.ThrottleAsync(1024, CancellationToken.None).AsTask();
        await Task.Delay(400);
        Assert.False(paused.IsCompleted);

        live.LiveStreams = 0;
        await paused.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void Speed_IsMeasuredPerDownload_AndInTotal()
    {
        var governor = Governor(new FakeLiveSignal());

        governor.Record("a", 1000);

        Assert.InRange(governor.Speed("a"), 0, 1000);
        Assert.Equal(0, governor.Speed("unknown"));
        governor.Forget("a");
        Assert.Equal(0, governor.Speed("a"));
    }

    [Fact]
    public async Task TheConnectionShare_BoundsDownloads_AndTheyEnterTheGlobalBudgetAtLowPriority()
    {
        var global = new SemaphoreNntpGate(new PrioritizedSemaphore(2, 2, new SemaphorePriorityOdds { HighPriorityOdds = 100 }));
        var share = new DownloadConnectionGate(global, () => 1);

        await share.AcquireAsync(SemaphorePriority.High, CancellationToken.None);
        var secondDownload = share.AcquireAsync(SemaphorePriority.High, CancellationToken.None).AsTask();
        await Task.Delay(50);
        Assert.False(secondDownload.IsCompleted);
        Assert.Equal(1, share.InUse);

        // Playback takes the last global connection; a queued playback read is served before the waiting download.
        await global.AcquireAsync(SemaphorePriority.High, CancellationToken.None);
        share.Release();
        var playback = global.AcquireAsync(SemaphorePriority.High, CancellationToken.None).AsTask();
        await Task.Delay(50);
        global.Release();
        await playback.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.False(secondDownload.IsCompleted);
        global.Release();
        await secondDownload.WaitAsync(TimeSpan.FromSeconds(1));
        share.Release();
        Assert.Equal(0, share.InUse);
    }

    [Fact]
    public async Task ALoweredShare_Drains_BeforeNewDownloadsEnter()
    {
        var limit = 2;
        var semaphore = new DynamicSemaphore(() => limit);
        await semaphore.WaitAsync(CancellationToken.None);
        await semaphore.WaitAsync(CancellationToken.None);
        limit = 1;
        var waiting = semaphore.WaitAsync(CancellationToken.None);

        semaphore.Release();
        await Task.Delay(30);
        Assert.False(waiting.IsCompleted);
        semaphore.Release();
        await waiting.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(1, semaphore.InUse);
    }

    private static SessionManager Sessions(int cacheSizeMb = 1, int ttlSeconds = 300, TimeProvider? time = null, int maxSessions = 200) => new(
        new FakeNntpClient(),
        Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { SessionTtlSeconds = ttlSeconds, EphemeralCacheSizeMb = cacheSizeMb, MaxSessions = maxSessions }),
        NullLogger<SessionManager>.Instance,
        time: time);

    private static ResolvedMediaFile File(long size) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = size,
        OpenStream = _ => new MemoryStream(new byte[16]),
    };

    [Fact]
    public void TransferSessions_HoldNoByteBudget_AndAPinnedOneIsNeverEvicted()
    {
        var sessions = Sessions(cacheSizeMb: 1);
        var transfer = sessions.CreateSession("rel-dl", "work-1", File(900_000), SessionManager.TransferClient, "viewer-1");
        Assert.True(transfer.TryPin());

        var playback = sessions.CreateSession("rel-play", "work-2", File(900_000), "streamarr-viewer", "viewer-2");
        var next = sessions.CreateSession("rel-play-2", "work-3", File(900_000), "streamarr-viewer", "viewer-2");

        Assert.True(sessions.TryGetSession(transfer.Token, out _));
        Assert.False(sessions.TryGetSession(playback.Token, out _));
        Assert.True(sessions.TryGetSession(next.Token, out _));
    }

    [Fact]
    public void ThePinnedTransferSession_OutlivesItsTtl_UntilTheTransferEnds()
    {
        var clock = new ManualClock(DateTimeOffset.UtcNow);
        var sessions = Sessions(ttlSeconds: 60, time: clock);
        var transfer = sessions.CreateSession("rel-dl", "work-1", File(1_000), SessionManager.TransferClient, "viewer-1");
        Assert.True(transfer.TryPin());

        clock.Advance(TimeSpan.FromMinutes(5));
        sessions.SweepExpired();
        Assert.True(sessions.TryGetSession(transfer.Token, out _));

        transfer.Unpin();
        sessions.SweepExpired();
        Assert.False(sessions.TryGetSession(transfer.Token, out _));
        Assert.False(transfer.TryPin());
    }

    [Fact]
    public void AtTheSessionLimit_AnIdleTransferSessionGoesFirst_APinnedOneNever()
    {
        var sessions = Sessions(maxSessions: 2);
        var pinned = sessions.CreateSession("rel-a", "work-1", File(10), SessionManager.TransferClient, "viewer-1");
        Assert.True(pinned.TryPin());
        var playback = sessions.CreateSession("rel-b", "work-2", File(10), "streamarr-viewer", "viewer-2");
        sessions.CreateSession("rel-c", "work-3", File(10), "streamarr-viewer", "viewer-2");

        Assert.True(sessions.TryGetSession(pinned.Token, out _));
        Assert.False(sessions.TryGetSession(playback.Token, out _));

        pinned.Unpin();
        var idleTransfer = pinned;
        sessions.CreateSession("rel-d", "work-4", File(10), "streamarr-viewer", "viewer-2");
        Assert.False(sessions.TryGetSession(idleTransfer.Token, out _));
    }

    [Fact]
    public async Task PacedStreams_CountAsLive_TransferStreamsDoNot()
    {
        var clock = new ManualClock(DateTimeOffset.UtcNow);
        var sessions = Sessions(time: clock);
        var session = sessions.CreateSession("rel-a", "work-1", File(16), "streamarr-viewer", "viewer-1");

        var transfer = sessions.OpenTransferStream(session, new FakeNntpClient(), 2);
        Assert.Equal(0, sessions.LiveStreams);
        Assert.False(sessions.LiveStreamsActive(TimeSpan.FromSeconds(15)));
        await transfer.DisposeAsync();

        var stream = sessions.OpenStream(session);
        Assert.Equal(1, sessions.LiveStreams);
        await stream.DisposeAsync();
        Assert.Equal(0, sessions.LiveStreams);
        Assert.True(sessions.LiveStreamsActive(TimeSpan.FromSeconds(15)));
        clock.Advance(TimeSpan.FromSeconds(16));
        Assert.False(sessions.LiveStreamsActive(TimeSpan.FromSeconds(15)));
    }

    [Fact]
    public void EverySession_RecordsItsExactFile_ForDownloadSizes()
    {
        var store = new ResolvedFileStore();
        var sessions = new SessionManager(
            new FakeNntpClient(),
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()),
            NullLogger<SessionManager>.Instance,
            resolvedFiles: store);

        sessions.CreateSession("rel-a", "tmdb-tv-1-s01e02", File(123_456), "jellyfin", "user");

        var file = store.Get("rel-a", "tmdb-tv-1-s01e02");
        Assert.Equal(123_456, file!.SizeBytes);
        Assert.Equal("video.mkv", file.FileName);
        Assert.Null(store.Get("rel-a", "tmdb-tv-1-s01e03"));
    }
}
