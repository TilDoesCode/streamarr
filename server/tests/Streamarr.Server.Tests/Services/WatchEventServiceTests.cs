using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Config;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Tests.Services;

public sealed class WatchEventServiceTests
{
    [Fact]
    public async Task ProgressCoalescing_PersistsLatestDurationAndSessionToken()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-events-contract-").FullName;
        try
        {
            var services = new ServiceCollection();
            services.AddDbContextFactory<StreamarrDbContext>(o =>
                o.UseSqlite($"Data Source={Path.Combine(directory, "events.db")}"));
            services.AddSingleton(TimeProvider.System);
            services.Configure<StreamarrOptions>(o => o.MaxWatchEvents = 10);
            services.AddSingleton<WatchEventService>();
            await using var provider = services.BuildServiceProvider();

            var dbFactory = provider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>();
            await using (var db = await dbFactory.CreateDbContextAsync())
                await db.Database.EnsureCreatedAsync();

            var events = provider.GetRequiredService<WatchEventService>();
            var first = await events.RecordAsync(
                Write("progress", "progress", 10) with
                {
                    DurationTicks = 1_000,
                    SessionToken = "session-token-old",
                },
                default);
            var updated = await events.RecordAsync(
                Write("progress", "progress", 20) with
                {
                    DurationTicks = 2_000,
                    SessionToken = "session-token-current",
                },
                default);

            Assert.Equal(first.Id, updated.Id);
            Assert.Equal(1, await events.CountAsync(default));

            await using var verificationDb = await dbFactory.CreateDbContextAsync();
            var persisted = Assert.Single(await verificationDb.WatchEvents.AsNoTracking().ToListAsync());
            Assert.Equal(20, persisted.PositionTicks);
            Assert.Equal(2_000, persisted.DurationTicks);
            Assert.Equal("session-token-current", persisted.SessionToken);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task ProgressIsCoalesced_AndOldestRowsArePrunedToConfiguredLimit()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-events-").FullName;
        try
        {
            var services = new ServiceCollection();
            services.AddDbContextFactory<StreamarrDbContext>(o =>
                o.UseSqlite($"Data Source={Path.Combine(directory, "events.db")}"));
            services.AddSingleton(TimeProvider.System);
            services.Configure<StreamarrOptions>(o => o.MaxWatchEvents = 3);
            services.AddSingleton<WatchEventService>();
            await using var provider = services.BuildServiceProvider();

            await using (var db = await provider.GetRequiredService<IDbContextFactory<StreamarrDbContext>>()
                             .CreateDbContextAsync())
                await db.Database.EnsureCreatedAsync();

            var events = provider.GetRequiredService<WatchEventService>();
            await events.RecordAsync(Write("one", "start", 0), default);
            await events.RecordAsync(Write("two", "start", 0), default);
            await events.RecordAsync(Write("progress", "progress", 10), default);
            await events.RecordAsync(Write("progress", "progress", 20), default);
            Assert.Equal(3, await events.CountAsync(default));
            Assert.Equal(20, (await events.RecentAsync(1, default))[0].PositionTicks);

            await events.RecordAsync(Write("four", "stop", 30), default);
            Assert.Equal(3, await events.CountAsync(default));
            Assert.DoesNotContain(await events.RecentAsync(10, default), e => e.ReleaseId == "one");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static WatchEventWrite Write(string releaseId, string kind, long position) => new()
    {
        ReleaseId = releaseId,
        WorkId = "work",
        Event = kind,
        PositionTicks = position,
        Source = "test",
        PlaybackSessionId = "play-session-1",
        ExternalUserId = "jellyfin-user-1",
        ExternalUserName = "Mara",
        DeviceName = "Living Room TV",
    };
}
