using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Config;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Tests.Services;

public sealed class WatchEventServiceTests
{
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
