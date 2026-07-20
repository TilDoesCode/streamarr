using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Core.Media;

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
            var registered = new RegisteredRelease
            {
                WorkId = "work-1",
                Release = new Release
                {
                    ReleaseId = "release-1",
                    Title = "Example.Movie.2026.1080p",
                    Indexer = "indexer",
                    SizeBytes = 4_000_000_000,
                    NzbUrl = "https://indexer.invalid/download/secret",
                    Score = 42,
                },
            };
            var descriptor = new NzbCacheDescriptor(
                "release-1",
                "work-1",
                "Example.Movie.2026.1080p",
                "indexer",
                4_000_000_000,
                ReleaseRegistrationSerializer.Serialize(registered));
            var fetches = 0;
            Task<byte[]> Fetch(CancellationToken _)
            {
                fetches++;
                return Task.FromResult(TestNzb());
            }

            var first = await service.GetOrCreateAsync(descriptor, Fetch, default);
            var second = await service.GetOrCreateAsync(descriptor, Fetch, default);
            var secondOwner = registered with
            {
                WorkId = "work-2",
                Release = registered.Release with { Score = 41 },
            };
            var secondOwnerDescriptor = descriptor with
            {
                WorkId = secondOwner.WorkId,
                ReleaseRegistrationJson = ReleaseRegistrationSerializer.Serialize(secondOwner),
            };
            var third = await service.GetOrCreateAsync(secondOwnerDescriptor, Fetch, default);

            Assert.False(first.CacheHit);
            Assert.True(second.CacheHit);
            Assert.True(third.CacheHit);
            Assert.Equal(1, fetches);
            var entry = Assert.Single(await service.ListAsync(default));
            Assert.Equal(2, entry.HitCount);
            Assert.Equal(1, entry.FileCount);
            Assert.Equal(1, entry.SegmentCount);
            Assert.DoesNotContain("http", entry.CacheFileName, StringComparison.OrdinalIgnoreCase);
            Assert.NotNull(entry.ReleaseRegistrationJson);
            Assert.DoesNotContain("secret", entry.ReleaseRegistrationJson, StringComparison.Ordinal);

            var restoredStore = new InMemoryReleaseStore();
            Assert.Equal(2, ReleaseRegistrationHydrationService.Restore([entry], restoredStore));
            var restored = restoredStore.Get("release-1", "work-1");
            Assert.NotNull(restored);
            Assert.Equal(42, restored.Release.Score);
            Assert.Equal("cache://release-1", restored.Release.NzbUrl);
            var restoredSecondOwner = restoredStore.Get("release-1", "work-2");
            Assert.NotNull(restoredSecondOwner);
            Assert.Equal(41, restoredSecondOwner.Release.Score);
            Assert.Equal("cache://release-1", restoredSecondOwner.Release.NzbUrl);

            Assert.True(await service.RemoveAsync(descriptor.ReleaseId, default));
            Assert.Empty(await service.ListAsync(default));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void RegistrationHydration_AcceptsLegacySingleObject_AndSkipsMalformedRows()
    {
        var legacyJson = ReleaseRegistrationSerializer.Serialize(Registration("release-legacy", "work-legacy"));
        Assert.StartsWith("{", legacyJson, StringComparison.Ordinal);
        var entries = new[]
        {
            new CachedReleaseEntity
            {
                ReleaseId = "malformed-json",
                ReleaseRegistrationJson = "{",
            },
            new CachedReleaseEntity
            {
                ReleaseId = "null-release",
                ReleaseRegistrationJson = """{"workId":"bad","release":null}""",
            },
            new CachedReleaseEntity
            {
                ReleaseId = "release-legacy",
                WorkId = "stale-scalar-owner",
                ReleaseRegistrationJson = legacyJson,
            },
        };
        var store = new InMemoryReleaseStore();

        var restored = ReleaseRegistrationHydrationService.Restore(entries, store);

        Assert.Equal(1, restored);
        Assert.NotNull(store.Get("release-legacy", "work-legacy"));
    }

    [Fact]
    public void RegistrationMerge_BoundsOwnersPerRelease()
    {
        var registrations = Enumerable
            .Range(0, ReleaseRegistrationSerializer.MaxRegistrationsPerRelease + 1)
            .Select(index => Registration("release-1", $"work-{index}"))
            .ToArray();
        var incoming = JsonSerializer.Serialize(
            registrations,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        var merged = ReleaseRegistrationSerializer.Merge(null, incoming);
        var restored = ReleaseRegistrationSerializer.DeserializeMany(Assert.IsType<string>(merged));

        Assert.Equal(ReleaseRegistrationSerializer.MaxRegistrationsPerRelease, restored.Count);
        Assert.All(restored, registration => Assert.Equal("cache://release-1", registration.Release.NzbUrl));
    }

    private static RegisteredRelease Registration(string releaseId, string workId) => new()
    {
        WorkId = workId,
        Release = new Release
        {
            ReleaseId = releaseId,
            Title = "Example.Movie.2026.1080p",
            Indexer = "indexer",
            SizeBytes = 4_000_000_000,
            NzbUrl = "https://indexer.invalid/download/secret",
        },
    };

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
