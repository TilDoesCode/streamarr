using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Tests.Integration;
using static Streamarr.Server.Tests.Viewers.MyListTmdbFake;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>My List over HTTP: entries, auto-add, derived status and progress, and the new-episode monitor.</summary>
public sealed class MyListTests
{
    private const string Weekly = "tmdb-tv-700";

    private static MyListFactory WeeklyWorld()
    {
        var factory = new MyListFactory();
        factory.Tmdb.Episodes[(WeeklyShow, 1)] = [(1, factory.Day(-21)), (2, factory.Day(-14)), (3, factory.Day(-7)), (4, factory.Day(7)), (5, factory.Day(14))];
        for (var e = 1; e <= 3; e++)
            factory.Newznab.Add(WeeklyShow, 1, $"Weekly.Show.S01E0{e}.1080p.WEB-DL.DDP5.1.H.264-GRP");
        return factory;
    }

    [Fact]
    public async Task WeeklyEpisodeIsFlaggedOnlyOnceUsableReleasesExist()
    {
        using var factory = WeeklyWorld();
        var viewer = await factory.ViewerAsync("weekly");
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-700-s01e01", "tmdb-tv-700-s01e02", "tmdb-tv-700-s01e03");

        var item = await MyListApi.ItemAsync(viewer, Weekly);
        Assert.Equal("auto", item.GetProperty("source").GetString());
        Assert.Equal("caught_up", item.GetProperty("status").GetString());
        Assert.Equal(3, item.GetProperty("playedEpisodes").GetInt32());
        Assert.Equal(3, item.GetProperty("totalEpisodes").GetInt32());
        Assert.Equal("tmdb-tv-700-s01e04", item.GetProperty("upcomingEpisode").GetProperty("workId").GetString());

        // Not aired yet: nothing is searched.
        var pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((0, 0), (pass.Lookups, pass.Flagged));

        // Aired and listed on TMDB, but no release yet: searched, not flagged.
        factory.Clock.Advance(TimeSpan.FromDays(7));
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((1, 0), (pass.Lookups, pass.Flagged));
        viewer = await factory.SignInAsync("weekly");
        Assert.Equal(0, (await MyListApi.SummaryAsync(viewer)).GetProperty("newCount").GetInt32());
        item = await MyListApi.ItemAsync(viewer, Weekly);
        Assert.Equal("caught_up", item.GetProperty("status").GetString());
        Assert.False(item.GetProperty("nextEpisode").GetProperty("available").GetBoolean());

        // Within the re-check interval the season is not searched again, even once releases exist.
        factory.Newznab.Add(WeeklyShow, 1, "Weekly.Show.S01E04.1080p.WEB-DL.DDP5.1.H.264-GRP");
        factory.Clock.Advance(TimeSpan.FromHours(1));
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((0, 0), (pass.Lookups, pass.Flagged));

        factory.Clock.Advance(TimeSpan.FromHours(3));
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((1, 1), (pass.Lookups, pass.Flagged));
        viewer = await factory.SignInAsync("weekly");
        var summary = await MyListApi.SummaryAsync(viewer);
        Assert.Equal(1, summary.GetProperty("newCount").GetInt32());
        Assert.Equal(1, summary.GetProperty("watching").GetInt32());
        item = await MyListApi.ItemAsync(viewer, Weekly);
        Assert.True(item.GetProperty("isNew").GetBoolean());
        Assert.Equal("watching", item.GetProperty("status").GetString());
        Assert.Equal("tmdb-tv-700-s01e04", item.GetProperty("newEpisodeWorkId").GetString());
        Assert.Equal("tmdb-tv-700-s01e04", item.GetProperty("nextEpisode").GetProperty("workId").GetString());

        // Flagged once only.
        factory.Clock.Advance(TimeSpan.FromHours(4));
        Assert.Equal(0, (await factory.Monitor.RunOnceAsync(default)).Flagged);

        // Playing the new episode clears the flag.
        viewer = await factory.SignInAsync("weekly");
        var start = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "start", workId = "tmdb-tv-700-s01e04", positionTicks = 0 });
        Assert.True(start.IsSuccessStatusCode, await start.Content.ReadAsStringAsync());
        Assert.Equal(0, (await MyListApi.SummaryAsync(viewer)).GetProperty("newCount").GetInt32());
    }

    [Fact]
    public async Task AllIndexersDownChangesNothing()
    {
        using var factory = WeeklyWorld();
        var viewer = await factory.ViewerAsync("down");
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-700-s01e01", "tmdb-tv-700-s01e02", "tmdb-tv-700-s01e03");
        factory.Newznab.Add(WeeklyShow, 1, "Weekly.Show.S01E04.1080p.WEB-DL.DDP5.1.H.264-GRP");
        factory.Clock.Advance(TimeSpan.FromDays(7));
        factory.Newznab.Down = true;

        var pass = await factory.Monitor.RunOnceAsync(default);
        Assert.True(pass.IndexersUnavailable);
        Assert.Equal(0, pass.Flagged);
        viewer = await factory.SignInAsync("down");
        var item = await MyListApi.ItemAsync(viewer, Weekly);
        Assert.False(item.GetProperty("isNew").GetBoolean());
        Assert.True(item.GetProperty("nextEpisode").GetProperty("available").GetBoolean(), "no lookup result was recorded");

        // No back-off was set: the next pass with indexers back flags at once.
        factory.Newznab.Down = false;
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((1, 1), (pass.Lookups, pass.Flagged));
    }

    [Fact]
    public async Task NewSeasonIsFlaggedAndEndedSeriesAreNotPolled()
    {
        using var factory = new MyListFactory();
        factory.Tmdb.Episodes[(SeasonShow, 1)] = [(1, factory.Day(-400)), (2, factory.Day(-393))];
        factory.Tmdb.Episodes[(EndedShow, 1)] = [(1, factory.Day(-300)), (2, factory.Day(-293))];
        factory.Tmdb.Status[EndedShow] = "Ended";
        var viewer = await factory.ViewerAsync("seasons");
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-720-s01e01", "tmdb-tv-720-s01e02", "tmdb-tv-710-s01e01", "tmdb-tv-710-s01e02");

        Assert.Equal("caught_up", (await MyListApi.ItemAsync(viewer, "tmdb-tv-720")).GetProperty("status").GetString());
        Assert.Equal("watched", (await MyListApi.ItemAsync(viewer, "tmdb-tv-710")).GetProperty("status").GetString());

        var pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((0, 0), (pass.Lookups, pass.Flagged));
        var endedCalls = factory.Tmdb.SeriesCalls(EndedShow);
        await factory.Monitor.RunOnceAsync(default);
        Assert.Equal(endedCalls, factory.Tmdb.SeriesCalls(EndedShow));

        // Season 2 appears on TMDB and airs; its release arrives the next day.
        factory.Tmdb.Episodes[(SeasonShow, 2)] = [(1, factory.Day(3)), (2, factory.Day(10))];
        factory.Clock.Advance(TimeSpan.FromDays(3));
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((1, 0), (pass.Lookups, pass.Flagged));
        factory.Newznab.Add(SeasonShow, 2, "Season.Show.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP");
        factory.Clock.Advance(TimeSpan.FromDays(1));
        pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((1, 1), (pass.Lookups, pass.Flagged));

        viewer = await factory.SignInAsync("seasons");
        var item = await MyListApi.ItemAsync(viewer, "tmdb-tv-720");
        Assert.True(item.GetProperty("isNew").GetBoolean());
        Assert.Equal("tmdb-tv-720-s02e01", item.GetProperty("newEpisodeWorkId").GetString());

        var seen = await viewer.PostAsync("/api/v1/viewer/list/tmdb-tv-720/seen", null);
        Assert.Equal(HttpStatusCode.NoContent, seen.StatusCode);
        Assert.Equal(0, (await MyListApi.SummaryAsync(viewer)).GetProperty("newCount").GetInt32());
    }

    [Fact]
    public async Task ViewersBehindAreNeitherSearchedNorFlagged()
    {
        using var factory = new MyListFactory();
        factory.Tmdb.Episodes[(SeasonShow, 1)] = [(1, factory.Day(-400)), (2, factory.Day(-393)), (3, factory.Day(-386))];
        var viewer = await factory.ViewerAsync("binge");
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-720-s01e01");

        var item = await MyListApi.ItemAsync(viewer, "tmdb-tv-720");
        Assert.Equal("watching", item.GetProperty("status").GetString());
        Assert.Equal("tmdb-tv-720-s01e02", item.GetProperty("nextEpisode").GetProperty("workId").GetString());
        Assert.Equal("next", item.GetProperty("nextEpisode").GetProperty("reason").GetString());

        var pass = await factory.Monitor.RunOnceAsync(default);
        Assert.Equal((0, 0), (pass.Lookups, pass.Flagged));
        Assert.Equal(0, factory.Newznab.Searches);
    }

    [Fact]
    public async Task ManualEntriesStatusesAndRemoval()
    {
        using var factory = new MyListFactory();
        factory.Tmdb.Episodes[(SeasonShow, 1)] = [(1, factory.Day(-400)), (2, factory.Day(-393))];
        factory.Tmdb.Episodes[(SeasonShow, 2)] = [(1, factory.Day(-30)), (2, factory.Day(30))];
        var viewer = await factory.ViewerAsync("manual");

        var empty = await MyListApi.SummaryAsync(viewer);
        Assert.Equal(0, empty.GetProperty("total").GetInt32());

        var movie = await (await viewer.PutAsync("/api/v1/viewer/list/tmdb-movie-701", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("want_to_watch", movie.GetProperty("status").GetString());
        Assert.Equal("manual", movie.GetProperty("source").GetString());
        Assert.Equal("List Movie", movie.GetProperty("title").GetString());

        var season = await (await viewer.PutAsync("/api/v1/viewer/list/tmdb-tv-720-s02", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("season", season.GetProperty("kind").GetString());
        Assert.Equal("Season Show", season.GetProperty("seriesTitle").GetString());
        Assert.Equal(1, season.GetProperty("totalEpisodes").GetInt32());
        Assert.Equal("start", season.GetProperty("nextEpisode").GetProperty("reason").GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PutAsync("/api/v1/viewer/list/tmdb-tv-720-s02e01", null)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.GetAsync("/api/v1/viewer/list?status=bogus")).StatusCode);

        // Movie: watching while in progress, watched once played; a viewer-set status holds until the next playback.
        var hour = TimeSpan.FromHours(1).Ticks;
        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-movie-701", positionTicks = hour / 2, durationTicks = hour });
        Assert.Equal("watching", (await MyListApi.ItemAsync(viewer, "tmdb-movie-701")).GetProperty("status").GetString());
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var marked = await (await viewer.PutAsJsonAsync("/api/v1/viewer/list/tmdb-movie-701", new { status = "watched" })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("watched", marked.GetProperty("status").GetString());
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-movie-701", positionTicks = hour / 2 + 1000, durationTicks = hour });
        Assert.Equal("watching", (await MyListApi.ItemAsync(viewer, "tmdb-movie-701")).GetProperty("status").GetString());

        // Season entry: watched once its aired episodes are played... caught up while one is still to air.
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-720-s02e01");
        var seasonItem = await MyListApi.ItemAsync(viewer, "tmdb-tv-720-s02");
        Assert.Equal("caught_up", seasonItem.GetProperty("status").GetString());
        Assert.Equal("auto", (await MyListApi.ItemAsync(viewer, "tmdb-tv-720")).GetProperty("source").GetString());

        var status = await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/list/tmdb-tv-720-s02");
        Assert.True(status.GetProperty("onList").GetBoolean());
        Assert.True(status.GetProperty("seriesOnList").GetBoolean());
        Assert.False((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/list/tmdb-tv-720-s01")).GetProperty("onList").GetBoolean());

        var filtered = await MyListApi.ListAsync(viewer, "caught_up");
        Assert.All(filtered.GetProperty("items").EnumerateArray(), i => Assert.Equal("caught_up", i.GetProperty("status").GetString()));

        // Removing the auto series keeps it off the list even when the viewer keeps watching.
        Assert.Equal(HttpStatusCode.NoContent, (await viewer.DeleteAsync("/api/v1/viewer/list/tmdb-tv-720")).StatusCode);
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-720-s01e01");
        Assert.DoesNotContain((await MyListApi.ListAsync(viewer)).GetProperty("items").EnumerateArray(), i => i.GetProperty("workId").GetString() == "tmdb-tv-720");
        Assert.False((await viewer.GetFromJsonAsync<JsonElement>("/api/v1/viewer/list/tmdb-tv-720")).GetProperty("onList").GetBoolean());

        // Adding it back by hand works.
        Assert.Equal(HttpStatusCode.OK, (await viewer.PutAsync("/api/v1/viewer/list/tmdb-tv-720", null)).StatusCode);
        Assert.Equal("manual", (await MyListApi.ItemAsync(viewer, "tmdb-tv-720")).GetProperty("source").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await viewer.DeleteAsync("/api/v1/viewer/list/tmdb-movie-701")).StatusCode);
        Assert.Equal(2, (await MyListApi.SummaryAsync(viewer)).GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task AgeLimitsApplyAndListsArePerViewer()
    {
        using var factory = new MyListFactory();
        var kid = await factory.ViewerAsync("kid", permissions: new { maxAge = 12 });
        var denied = await kid.PutAsync("/api/v1/viewer/list/tmdb-movie-702", null);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("age_restricted", await ViewerApi.ErrorCodeAsync(denied));

        var adult = await factory.ViewerAsync("adult");
        Assert.Equal(HttpStatusCode.OK, (await adult.PutAsync("/api/v1/viewer/list/tmdb-movie-702", null)).StatusCode);
        Assert.Equal(0, (await MyListApi.SummaryAsync(kid)).GetProperty("total").GetInt32());
        Assert.Equal(1, (await MyListApi.SummaryAsync(adult)).GetProperty("total").GetInt32());

        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/api/v1/viewer/list")).StatusCode);
    }

    [Fact]
    public async Task MigrationBackfillsStartedSeries()
    {
        using var factory = new MyListFactory();
        factory.Tmdb.Episodes[(SeasonShow, 1)] = [(1, factory.Day(-400)), (2, factory.Day(-393))];
        var viewer = await factory.ViewerAsync("backfill");
        await MyListApi.MarkPlayedAsync(viewer, "tmdb-tv-720-s01e01");

        // Simulate an upgrade: drop the list rows and run the migration's backfill again.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var dbFactory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>();
            await using var db = await dbFactory.CreateDbContextAsync();
            await db.ViewerListEntries.ExecuteDeleteAsync();
            var migration = new Streamarr.Server.Persistence.Migrations.ViewerMyList();
            var builder = new Microsoft.EntityFrameworkCore.Migrations.MigrationBuilder("Microsoft.EntityFrameworkCore.Sqlite");
            typeof(Streamarr.Server.Persistence.Migrations.ViewerMyList)
                .GetMethod("Up", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
                .Invoke(migration, [builder]);
            var backfill = builder.Operations.OfType<Microsoft.EntityFrameworkCore.Migrations.Operations.SqlOperation>().Single();
            await db.Database.ExecuteSqlRawAsync(backfill.Sql);
        }

        var item = await MyListApi.ItemAsync(viewer, "tmdb-tv-720");
        Assert.Equal("auto", item.GetProperty("source").GetString());
        Assert.Equal("watching", item.GetProperty("status").GetString());
    }
}
