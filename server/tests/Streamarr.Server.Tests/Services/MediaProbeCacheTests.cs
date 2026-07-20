using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class MediaProbeCacheTests
{
    [Fact]
    public async Task GetOrCreate_PersistsAcrossServiceInstances_AndInvalidatesChangedFileIdentity()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-probe-cache-").FullName;
        try
        {
            var dbOptions = new DbContextOptionsBuilder<StreamarrDbContext>()
                .UseSqlite($"Data Source={Path.Combine(directory, "cache.db")}")
                .Options;
            var factory = new TestDbFactory(dbOptions);
            await using (var db = await factory.CreateDbContextAsync())
            {
                await db.Database.EnsureCreatedAsync();
                db.CachedReleases.Add(new CachedReleaseEntity
                {
                    ReleaseId = "release-1",
                    WorkId = "work-1",
                    Title = "Movie",
                    Indexer = "indexer",
                    CacheFileName = "cache.nzb",
                    CachedAt = DateTimeOffset.UtcNow,
                    LastAccessedAt = DateTimeOffset.UtcNow,
                });
                await db.SaveChangesAsync();
            }

            var media = Media(["one@test", "two@test"]);
            var expected = new FfprobeResult
            {
                RunTimeTicks = TimeSpan.FromMinutes(90).Ticks,
                MediaStreams = [new MediaStreamInfo { Type = "Video", Codec = "h264", Width = 1920, Height = 1080 }],
            };
            var probes = 0;
            Task<FfprobeResult?> Probe(CancellationToken _)
            {
                probes++;
                return Task.FromResult<FfprobeResult?>(expected);
            }

            var firstService = Service(factory);
            Assert.NotNull(await firstService.GetOrCreateAsync("release-1", media, Probe, default));
            var secondService = Service(factory);
            var cached = await secondService.GetOrCreateAsync("release-1", media, Probe, default);

            Assert.Equal(1, probes);
            Assert.Equal(expected.RunTimeTicks, cached!.RunTimeTicks);
            Assert.Single(cached.MediaStreams);

            await secondService.GetOrCreateAsync(
                "release-1",
                Media(["one@test", "changed@test"]),
                Probe,
                default);
            Assert.Equal(2, probes);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static MediaProbeCache Service(IDbContextFactory<StreamarrDbContext> factory)
        => new(factory, TimeProvider.System, NullLogger<MediaProbeCache>.Instance);

    private static ResolvedMediaFile Media(string[] segmentIds) => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = 123_456,
        SegmentIds = segmentIds,
        OpenStream = _ => Stream.Null,
    };

    private sealed class TestDbFactory(DbContextOptions<StreamarrDbContext> options)
        : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(CreateDbContext());
    }
}
