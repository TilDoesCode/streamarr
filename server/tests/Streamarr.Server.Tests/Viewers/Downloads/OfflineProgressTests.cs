using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Watch progress played offline and reported later (<c>occurredAt</c>).</summary>
public sealed class OfflineProgressTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 6, 20, 0, 0, TimeSpan.Zero);
    private static readonly ViewerSettings Settings = new();
    private static readonly WorkKey Movie = WorkKey.TryParse("tmdb-movie-603")!;
    private static readonly long Hour = TimeSpan.FromHours(1).Ticks;

    private static ViewerWatchStateEntity State() => new() { ViewerId = "v", WorkId = Movie.WorkId, Kind = "movie" };

    private static WatchReport Report(string kind, long position, DateTimeOffset? at, string playback = "p1")
        => new() { Event = kind, Work = Movie, PositionTicks = position, DurationTicks = Hour, PlaybackId = playback, OccurredAt = at };

    [Fact]
    public void AnOfflineReport_CountsAtItsRealTime()
    {
        var state = State();

        WatchProgressRules.Apply(state, Report("progress", Hour / 3, Now.AddHours(-5)), Settings, Now);

        Assert.Equal(Now.AddHours(-5), state.LastPlayedAt);
        Assert.Equal(Hour / 3, state.PositionTicks);
        Assert.Equal(Now, state.UpdatedAt);
    }

    [Fact]
    public void InterleavedReplays_CountEveryPlaybackOnce_StaleReports()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour * 3 / 10, Now), Settings, Now);

        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Now.AddDays(-2), "offline-A"), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Now.AddDays(-2), "offline-A"), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Now.AddDays(-1), "offline-B"), Settings, Now);
        WatchProgressRules.Apply(state, Report("progress", Hour * 95 / 100, Now.AddDays(-2), "offline-A"), Settings, Now);

        Assert.Equal(2, state.PlayCount);
        Assert.Equal(Hour * 3 / 10, state.PositionTicks);
    }

    [Fact]
    public void InterleavedReplays_CountEveryPlaybackOnce_LiveReports()
    {
        var state = State();

        WatchProgressRules.Apply(state, Report("stop", Hour * 95 / 100, Now.AddMinutes(1), "A"), Settings, Now.AddMinutes(1));
        WatchProgressRules.Apply(state, Report("stop", Hour * 95 / 100, Now.AddMinutes(2), "B"), Settings, Now.AddMinutes(2));
        WatchProgressRules.Apply(state, Report("stop", Hour * 95 / 100, Now.AddMinutes(3), "A"), Settings, Now.AddMinutes(3));

        Assert.Equal(2, state.PlayCount);
    }

    [Fact]
    public void AStaleCompletion_IsJudgedAgainstItsOwnDuration()
    {
        var state = State();
        var longVersion = TimeSpan.FromSeconds(1000).Ticks;
        WatchProgressRules.Apply(state, new WatchReport { Event = "progress", Work = Movie, PositionTicks = longVersion * 3 / 10, DurationTicks = longVersion, PlaybackId = "new" },
            Settings, Now);

        var shortVersion = TimeSpan.FromSeconds(500).Ticks;
        WatchProgressRules.Apply(state, new WatchReport
        {
            Event = "progress", Work = Movie, PositionTicks = shortVersion * 95 / 100, DurationTicks = shortVersion, PlaybackId = "old", OccurredAt = Now.AddDays(-2),
        }, Settings, Now);

        Assert.True(state.Played);
        Assert.Equal(1, state.PlayCount);
        Assert.Equal(longVersion * 3 / 10, state.PositionTicks);
        Assert.Equal(longVersion, state.DurationTicks);
    }

    [Fact]
    public void ManyCompletions_KeepABoundedMemory_AndTheOldOnesStillCount()
    {
        var state = State();
        for (var i = 0; i < WatchProgressRules.MaxCountedPlaybacks + 5; i++)
            WatchProgressRules.Apply(state, Report("stop", Hour * 95 / 100, Now.AddMinutes(i), $"p{i}"), Settings, Now.AddMinutes(i));

        Assert.Equal(WatchProgressRules.MaxCountedPlaybacks + 5, state.PlayCount);
        Assert.Equal(WatchProgressRules.MaxCountedPlaybacks, state.CountedPlaybackIds!.Split('\n').Length);
    }

    [Fact]
    public void OccurredAt_IsClampedToTheLastThirtyDays_AndNeverInTheFuture()
    {
        Assert.Equal(Now.AddDays(-30), WatchProgressRules.OccurredAt(Report("progress", 0, Now.AddDays(-90)), Now));
        Assert.Equal(Now, WatchProgressRules.OccurredAt(Report("progress", 0, Now.AddDays(2)), Now));
        Assert.Equal(Now, WatchProgressRules.OccurredAt(Report("progress", 0, null), Now));
    }

    [Fact]
    public void AnOlderOfflineReport_NeverOverwritesNewerProgressMadeElsewhere()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour / 2, Now.AddMinutes(-10), "online"), Settings, Now);

        WatchProgressRules.Apply(state, Report("stop", Hour / 5, Now.AddHours(-3), "offline"), Settings, Now);

        Assert.Equal(Hour / 2, state.PositionTicks);
        Assert.Equal(Now.AddMinutes(-10), state.LastPlayedAt);
        Assert.False(state.Played);
    }

    [Fact]
    public void AnOlderOfflineCompletion_StillCountsAsPlayed_OncePerPlayback_KeepingTheNewerResumePoint()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour / 2, Now.AddMinutes(-10), "online"), Settings, Now);

        WatchProgressRules.Apply(state, Report("stop", Hour * 95 / 100, Now.AddHours(-3), "offline"), Settings, Now);
        WatchProgressRules.Apply(state, Report("stop", Hour * 99 / 100, Now.AddHours(-3), "offline"), Settings, Now);

        Assert.True(state.Played);
        Assert.Equal(1, state.PlayCount);
        Assert.Equal(Now.AddHours(-3), state.PlayedAt);
        Assert.Equal(Hour / 2, state.PositionTicks);
        Assert.Equal(Now.AddMinutes(-10), state.LastPlayedAt);
    }

    [Fact]
    public void ANewerOfflineReport_AppliesNormally()
    {
        var state = State();
        WatchProgressRules.Apply(state, Report("progress", Hour / 4, Now.AddHours(-6), "a"), Settings, Now);

        WatchProgressRules.Apply(state, Report("progress", Hour * 92 / 100, Now.AddHours(-1), "b"), Settings, Now);

        Assert.True(state.Played);
        Assert.Equal(0, state.PositionTicks);
        Assert.Equal(Now.AddHours(-1), state.PlayedAt);
        Assert.Equal(Now.AddHours(-1), state.LastPlayedAt);
    }
}

/// <summary><c>occurredAt</c> over the real progress endpoint.</summary>
public sealed class OfflineProgressApiTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>
{
    [Fact]
    public async Task TheProgressEndpoint_TakesOccurredAt_AndLeavesNewerProgressAlone()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var (viewer, _, _) = await Dl.ViewerAsync(factory, admin, "offline-progress");
        var now = factory.Clock.GetUtcNow();
        var duration = TimeSpan.FromMinutes(100).Ticks;

        var online = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "progress", workId = "tmdb-movie-501", positionTicks = duration / 2, durationTicks = duration, playbackId = "online",
        });
        Assert.True(online.IsSuccessStatusCode);
        var stale = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new
        {
            @event = "stop", workId = "tmdb-movie-501", positionTicks = duration / 10, durationTicks = duration, playbackId = "offline",
            occurredAt = now.AddDays(-2),
        });
        var body = JsonDocument.Parse(await stale.Content.ReadAsStringAsync()).RootElement;

        Assert.True(stale.IsSuccessStatusCode, body.ToString());
        Assert.Equal(duration / 2, body.GetProperty("positionTicks").GetInt64());
        Assert.True(body.GetProperty("lastPlayedAt").GetDateTimeOffset() >= now.AddMinutes(-1));
    }
}
