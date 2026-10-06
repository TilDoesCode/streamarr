using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

public sealed class ReleaseContainerStoreTests
{
    [Fact]
    public async Task Store_EvictsTheLeastRecentlyUsed_AndSurvivesARestart()
    {
        var dir = Directory.CreateTempSubdirectory("streamarr-containers-").FullName;
        try
        {
            var db = new TestDbFactory(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={Path.Combine(dir, "c.db")}").Options);
            await using (var context = await db.CreateDbContextAsync())
                await context.Database.EnsureCreatedAsync();
            var clock = new ManualClock();
            var store = new ReleaseContainerStore(db, null, clock, NullLogger<ReleaseContainerStore>.Instance) { MaxEntries = 10 };
            await store.StartAsync(CancellationToken.None);

            for (var i = 0; i < 10; i++)
            {
                store.Record($"r{i}", i % 2 == 0 ? "mp4" : "matroska,webm");
                clock.Advance(TimeSpan.FromHours(7));
            }
            Assert.Equal("mp4", store.Get("r0"));
            clock.Advance(TimeSpan.FromHours(7));
            store.Record("r10", "ts");

            Assert.Equal(9, store.Count);
            Assert.Null(store.Get("r1"));
            Assert.Null(store.Get("r2"));
            Assert.Equal("mp4", store.Get("r0"));
            Assert.Equal("mkv", store.Get("r3"));
            Assert.Equal("ts", store.Get("r10"));
            await store.StopAsync(CancellationToken.None);
            Assert.Equal(9, await CountAsync(db));

            var reloaded = new ReleaseContainerStore(db, null, clock, NullLogger<ReleaseContainerStore>.Instance) { MaxEntries = 5 };
            await reloaded.StartAsync(CancellationToken.None);
            await reloaded.Loaded.WaitAsync(TimeSpan.FromSeconds(30));

            Assert.Equal(["r0", "r10", "r3", "r8", "r9"], new[] { "r0", "r10", "r3", "r7", "r8", "r9" }.Where(id => reloaded.Get(id) is not null));
            Assert.Equal("mp4", reloaded.Get("r0"));
            await reloaded.StopAsync(CancellationToken.None);
            Assert.Equal(5, await CountAsync(db));
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Store_WithoutADatabase_StillAnswersFromMemory()
    {
        var store = new ReleaseContainerStore();

        store.Record("a", ".MKV");
        store.Record("b", "mov,mp4,m4a,3gp,3g2,mj2");
        store.Record("c", null);

        Assert.Equal(("mkv", "mp4", (string?)null), (store.Get("a"), store.Get("b"), store.Get("c")));
    }

    private static async Task<int> CountAsync(TestDbFactory db)
    {
        await using var context = await db.CreateDbContextAsync();
        return await context.ReleaseContainers.CountAsync();
    }

    private sealed class ManualClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
        public void Advance(TimeSpan by) => _now += by;
        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class TestDbFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default) => Task.FromResult(CreateDbContext());
    }
}
