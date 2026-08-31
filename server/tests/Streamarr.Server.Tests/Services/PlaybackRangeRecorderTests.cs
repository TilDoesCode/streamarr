using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class PlaybackRangeRecorderTests : IAsyncLifetime
{
    private static readonly DateTimeOffset T0 = DateTimeOffset.Parse("2026-08-29T20:00:00Z");
    private static readonly long Second = TimeSpan.TicksPerSecond;

    private readonly string _directory = Directory.CreateTempSubdirectory("streamarr-ranges-").FullName;
    private ServiceProvider _provider = null!;
    private IDbContextFactory<StreamarrDbContext> _dbFactory = null!;
    private readonly PlaybackRangeRecorder _recorder = new();

    public async Task InitializeAsync()
    {
        var services = new ServiceCollection();
        services.AddDbContextFactory<StreamarrDbContext>(o =>
            o.UseSqlite($"Data Source={Path.Combine(_directory, "ranges.db")}"));
        _provider = services.BuildServiceProvider();
        _dbFactory = _provider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>();
        await using var db = await _dbFactory.CreateDbContextAsync();
        await db.Database.EnsureCreatedAsync();
    }

    public async Task DisposeAsync()
    {
        await _provider.DisposeAsync();
        Directory.Delete(_directory, recursive: true);
    }

    [Fact]
    public async Task ContinuousHeartbeats_FoldIntoOneAttributedSpan()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 10, atSeconds: 10);
        await Record("progress", positionSeconds: 20, atSeconds: 20);

        var row = await SingleRow();
        var spans = PlaybackRangeRecorder.Parse(row.RangesJson);
        var span = Assert.Single(spans);
        Assert.Equal(0, span.StartTicks);
        Assert.Equal(20 * Second, span.EndTicks);
        Assert.Equal("tok-a", span.SessionToken);
        Assert.Equal("rel-a", span.ReleaseId);
        Assert.Equal(20 * Second, row.PositionTicks);
        Assert.Equal(42 * 60 * Second, row.DurationTicks);
    }

    [Fact]
    public async Task ForwardSeek_ReAnchorsWithoutFillingTheGap()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 10, atSeconds: 10);
        await Record("progress", positionSeconds: 20 * 60, atSeconds: 20);
        await Record("progress", positionSeconds: 20 * 60 + 10, atSeconds: 30);

        var spans = PlaybackRangeRecorder.Parse((await SingleRow()).RangesJson);
        Assert.Equal(2, spans.Count);
        Assert.Equal((0L, 10 * Second), (spans[0].StartTicks, spans[0].EndTicks));
        Assert.Equal((20 * 60 * Second, (20 * 60 + 10) * Second), (spans[1].StartTicks, spans[1].EndTicks));
    }

    [Fact]
    public async Task PauseAndBackwardSeek_ProduceNoSpan()
    {
        await Record("start", positionSeconds: 30, atSeconds: 0);
        await Record("progress", positionSeconds: 30, atSeconds: 10); // paused: no advance
        await Record("progress", positionSeconds: 10, atSeconds: 20); // seek back: re-anchor
        await Record("progress", positionSeconds: 18, atSeconds: 28); // then watch 10 → 18

        var spans = PlaybackRangeRecorder.Parse((await SingleRow()).RangesJson);
        var span = Assert.Single(spans);
        Assert.Equal((10 * Second, 18 * Second), (span.StartTicks, span.EndTicks));
    }

    [Fact]
    public async Task ReleaseSwitch_AttributesSpansToEachToken()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 10, atSeconds: 10);
        await Record("progress", positionSeconds: 20, atSeconds: 20, token: "tok-b", releaseId: "rel-b");
        await Record("progress", positionSeconds: 30, atSeconds: 30, token: "tok-b", releaseId: "rel-b");

        var row = await SingleRow();
        var spans = PlaybackRangeRecorder.Parse(row.RangesJson);
        Assert.Equal(2, spans.Count);
        Assert.Equal("tok-a", spans[0].SessionToken);
        Assert.Equal("tok-b", spans[1].SessionToken);
        // The switch itself (10 → 20 across tokens) is not credited to either release.
        Assert.Equal((20 * Second, 30 * Second), (spans[1].StartTicks, spans[1].EndTicks));
        Assert.Equal("tok-b", row.LastSessionToken);
        Assert.Equal("rel-b", row.LastReleaseId);
    }

    [Fact]
    public async Task StaleAnchor_OnlyReAnchors()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 200, atSeconds: 200); // > MaxHeartbeatGap
        await Record("progress", positionSeconds: 210, atSeconds: 210);

        var spans = PlaybackRangeRecorder.Parse((await SingleRow()).RangesJson);
        var span = Assert.Single(spans);
        Assert.Equal((200 * Second, 210 * Second), (span.StartTicks, span.EndTicks));
    }

    [Fact]
    public async Task Stop_CreditsTheFinalStretchAndDropsTheAnchor()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 10, atSeconds: 10);
        await Record("stop", positionSeconds: 15, atSeconds: 15);
        // After stop, a lone progress far later must not bridge from the stopped position.
        await Record("progress", positionSeconds: 300, atSeconds: 20);
        await Record("progress", positionSeconds: 310, atSeconds: 30);

        var spans = PlaybackRangeRecorder.Parse((await SingleRow()).RangesJson);
        Assert.Equal(2, spans.Count);
        Assert.Equal((0L, 15 * Second), (spans[0].StartTicks, spans[0].EndTicks));
        Assert.Equal((300 * Second, 310 * Second), (spans[1].StartTicks, spans[1].EndTicks));
    }

    [Fact]
    public void Normalize_MergesSameTokenNeighboursAndBoundsSpanCount()
    {
        var spans = new List<PlaybackRangeSpan>
        {
            new() { StartTicks = 0, EndTicks = 10 * Second, SessionToken = "a" },
            new() { StartTicks = 12 * Second, EndTicks = 20 * Second, SessionToken = "a" }, // gap 2 s → merge
            new() { StartTicks = 21 * Second, EndTicks = 30 * Second, SessionToken = "b" }, // other token → keep
        };
        var merged = PlaybackRangeRecorder.Normalize(spans);
        Assert.Equal(2, merged.Count);
        Assert.Equal((0L, 20 * Second), (merged[0].StartTicks, merged[0].EndTicks));
        Assert.Equal("b", merged[1].SessionToken);

        var many = Enumerable.Range(0, PlaybackRangeRecorder.MaxSpansPerScope + 40)
            .Select(i => new PlaybackRangeSpan
            {
                StartTicks = i * 60 * Second,
                EndTicks = i * 60 * Second + 10 * Second,
                SessionToken = "a",
            })
            .ToList();
        Assert.Equal(PlaybackRangeRecorder.MaxSpansPerScope, PlaybackRangeRecorder.Normalize(many).Count);
    }

    [Fact]
    public async Task DistinctPlaybackSessions_GetDistinctScopes()
    {
        await Record("start", positionSeconds: 0, atSeconds: 0);
        await Record("progress", positionSeconds: 10, atSeconds: 10);
        await Record("start", positionSeconds: 0, atSeconds: 0, playbackSessionId: "play-2");
        await Record("progress", positionSeconds: 10, atSeconds: 10, playbackSessionId: "play-2");

        await using var db = await _dbFactory.CreateDbContextAsync();
        Assert.Equal(2, await db.PlaybackRanges.CountAsync());
    }

    private async Task Record(
        string kind,
        long positionSeconds,
        long atSeconds,
        string token = "tok-a",
        string releaseId = "rel-a",
        string playbackSessionId = "play-1")
    {
        await using var db = await _dbFactory.CreateDbContextAsync();
        var write = new WatchEventWrite
        {
            ReleaseId = releaseId,
            WorkId = "work-1",
            Event = kind,
            PositionTicks = positionSeconds * Second,
            DurationTicks = 42 * 60 * Second,
            SessionToken = token,
            Source = "jellyfin",
            PlaybackSessionId = playbackSessionId,
            ExternalUserId = "user-1",
            ExternalUserName = "Mara",
            DeviceName = "Living Room TV",
        };
        await _recorder.RecordAsync(db, write, "work-1", "Example Title", T0.AddSeconds(atSeconds), default);
    }

    private async Task<PlaybackRangeEntity> SingleRow()
    {
        await using var db = await _dbFactory.CreateDbContextAsync();
        return Assert.Single(await db.PlaybackRanges.AsNoTracking().ToListAsync());
    }
}
