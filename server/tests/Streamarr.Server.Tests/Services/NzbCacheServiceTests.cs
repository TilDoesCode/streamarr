using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class NzbCacheServiceTests
{
    [Fact]
    public async Task GetOrCreate_PersistsAndReusesNzb_WithoutPersistingSourceUrl()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-nzb-cache-").FullName;
        try
        {
            var dbOptions = new DbContextOptionsBuilder<StreamarrDbContext>()
                .UseSqlite($"Data Source={Path.Combine(directory, "cache.db")}")
                .Options;
            var factory = new TestDbFactory(dbOptions);
            await using (var db = await factory.CreateDbContextAsync())
                await db.Database.EnsureCreatedAsync();

            var configured = Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                NzbCachePath = Path.Combine(directory, "nzbs"),
                NzbCacheSizeMb = 16,
                NzbCacheMaxEntries = 10,
            });
            var service = new NzbCacheService(
                factory,
                configured,
                new TestEnvironment(directory),
                TimeProvider.System,
                NullLogger<NzbCacheService>.Instance);
            var descriptor = new NzbCacheDescriptor(
                "release-1", "work-1", "Example.Movie.2026.1080p", "indexer", 4_000_000_000);
            var fetches = 0;
            Task<byte[]> Fetch(CancellationToken _)
            {
                fetches++;
                return Task.FromResult(TestNzb());
            }

            var first = await service.GetOrCreateAsync(descriptor, Fetch, default);
            var second = await service.GetOrCreateAsync(descriptor, Fetch, default);

            Assert.False(first.CacheHit);
            Assert.True(second.CacheHit);
            Assert.Equal(1, fetches);
            var entry = Assert.Single(await service.ListAsync(default));
            Assert.Equal(1, entry.HitCount);
            Assert.Equal(1, entry.FileCount);
            Assert.Equal(1, entry.SegmentCount);
            Assert.DoesNotContain("http", entry.CacheFileName, StringComparison.OrdinalIgnoreCase);

            Assert.True(await service.RemoveAsync(descriptor.ReleaseId, default));
            Assert.Empty(await service.ListAsync(default));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static byte[] TestNzb() => Encoding.UTF8.GetBytes("""
        <?xml version="1.0" encoding="utf-8"?>
        <nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
          <file poster="poster@example.test" date="1700000000" subject="&quot;movie.mkv&quot; yEnc (1/1)">
            <groups><group>alt.binaries.test</group></groups>
            <segments><segment bytes="100" number="1">chunk-1@example.test</segment></segments>
          </file>
        </nzb>
        """);

    private sealed class TestDbFactory(DbContextOptions<StreamarrDbContext> options)
        : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(CreateDbContext());
    }

    private sealed class TestEnvironment(string contentRoot) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Development;
        public string ApplicationName { get; set; } = "Streamarr.Tests";
        public string ContentRootPath { get; set; } = contentRoot;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
