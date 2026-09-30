using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

public sealed class CatalogSpecTests
{
    [Theory]
    [InlineData("Movie.2021.2160p.UHD.BluRay.TrueHD.Atmos.7.1.DV.HDR10.x265-GRP", "4K", "DV", "HEVC", "Atmos")]
    [InlineData("Movie.2021.1080p.WEB-DL.DDP5.1.H.264-GRP", "1080p", null, "H.264", "5.1")]
    [InlineData("Movie.2021.720p.WEB-DL.AAC2.0.H.264.MP4-GRP", "720p", null, "H.264", "2.0")]
    [InlineData("Movie.2021.1080p.WEB-DL.Opus.5.1.AV1-GRP", "1080p", null, "AV1", "5.1")]
    [InlineData("Movie.2021.2160p.WEB-DL.DTS.HLG.x265-GRP", "4K", "HLG", "HEVC", "DTS")]
    [InlineData("Movie.2021.1080p.BluRay.HDR10Plus.x265-GRP", "1080p", "HDR10+", "HEVC", null)]
    public void Labels_FollowTheParsedName(string name, string? resolution, string? hdr, string? codec, string? audio)
    {
        var spec = CatalogSpecMapper.From(Version(name))!;

        Assert.Equal((resolution, hdr, codec, audio), (spec.Resolution, spec.Hdr, spec.VideoCodec, spec.Audio));
    }

    [Fact]
    public void NamesWithoutTechnicalHints_HaveNoSpec()
    {
        Assert.Null(CatalogSpecMapper.From(Version("Some Movie 2021")));
        Assert.Null(CatalogSpecMapper.From(null));
    }

    [Fact]
    public void Score_PrefersResolutionThenHdrThenCodecThenAudio()
    {
        CatalogSpecDto[] ordered =
        [
            new() { Resolution = "4K", Hdr = "DV", VideoCodec = "HEVC", Audio = "Atmos" },
            new() { Resolution = "4K", Hdr = "HDR10", VideoCodec = "HEVC", Audio = "Atmos" },
            new() { Resolution = "4K", VideoCodec = "AV1", Audio = "2.0" },
            new() { Resolution = "4K", VideoCodec = "HEVC", Audio = "7.1" },
            new() { Resolution = "1080p", VideoCodec = "H.264", Audio = "Atmos" },
            new() { Resolution = "1080p", VideoCodec = "H.264", Audio = "5.1" },
            new() { Resolution = "720p", Hdr = "DV" },
            new() { Resolution = "SD" },
        ];

        Assert.Equal(ordered, ordered.Reverse().OrderByDescending(CatalogSpecMapper.Score));
    }

    [Fact]
    public async Task Store_ServesSeriesAsTheBestSeason_AndPersists()
    {
        var dir = Directory.CreateTempSubdirectory("streamarr-spec-").FullName;
        try
        {
            var db = new TestDbFactory(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={Path.Combine(dir, "spec.db")}").Options);
            await using (var context = await db.CreateDbContextAsync())
                await context.Database.EnsureCreatedAsync();
            var hd = new CatalogSpecDto { Resolution = "1080p", VideoCodec = "H.264", Audio = "5.1" };
            var uhd = new CatalogSpecDto { Resolution = "4K", Hdr = "HDR10", VideoCodec = "HEVC", Audio = "Atmos" };

            var store = new CatalogSpecStore(db, TimeProvider.System, NullLogger<CatalogSpecStore>.Instance);
            await store.StartAsync(CancellationToken.None);
            store.Record("tmdb-tv-7-s01", hd);
            store.Record("tmdb-tv-7-s02", uhd);
            store.Record("tmdb-tv-7-s02e01", uhd);
            store.Record("tmdb-tv-77-s01", hd);
            store.Record("tmdb-movie-7", null);

            Assert.Equal(uhd, store.Get("tmdb-tv-7"));
            Assert.Equal(hd, store.Get("tmdb-tv-7-s01"));
            Assert.Equal(uhd, store.Get("tmdb-tv-7-s02e01"));
            Assert.Null(store.Get("tmdb-tv-7-s02e02"));
            Assert.Null(store.Get("tmdb-movie-7"));
            Assert.Null(store.Get("tmdb-tv-8"));
            for (var i = 0; i < 100; i++)
            {
                await using var context = await db.CreateDbContextAsync();
                if (await context.CatalogSpecSummaries.CountAsync() == 5)
                    break;
                await Task.Delay(20);
            }
            await store.StopAsync(CancellationToken.None);

            var reloaded = new CatalogSpecStore(db, TimeProvider.System, NullLogger<CatalogSpecStore>.Instance);
            await reloaded.StartAsync(CancellationToken.None);
            for (var i = 0; i < 100 && reloaded.Get("tmdb-tv-7") is null; i++)
                await Task.Delay(20);
            Assert.Equal(uhd, reloaded.Get("tmdb-tv-7"));
            Assert.Equal(hd, reloaded.Get("tmdb-tv-77"));
            await reloaded.StopAsync(CancellationToken.None);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(dir, recursive: true);
        }
    }

    private static VersionDto Version(string name)
        => VersionMapper.Map(new Release { ReleaseId = "r", Title = name, Indexer = "i", SizeBytes = 1 }, ReleaseParser.Parse(name), 1, ReleaseHealth.Unknown, null, null, null);

    private sealed class TestDbFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default) => Task.FromResult(CreateDbContext());
    }
}
