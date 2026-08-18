using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Tests.Services;

public sealed class PreDownloadConfigServiceTests
{
    [Fact]
    public void Defaults_AreSafeAndExpected()
    {
        var options = new PreDownloadOptions();
        var entity = PreDownloadConfigService.FromOptionsEntity(options);

        Assert.False(entity.Enabled);
        Assert.True(entity.DownloadCurrentFile);
        Assert.Equal(10, entity.CurrentFileThresholdSeconds);
        Assert.True(entity.DownloadNextEpisode);
        Assert.Equal(75, entity.NextEpisodeThresholdPercent);
        Assert.Equal(1, entity.MaxConcurrentDownloads);
        Assert.Equal(string.Empty, options.CachePath);
        Assert.Equal(1L * 1024 * 1024 * 1024, options.MinimumFreeDiskBytes);
    }

    [Fact]
    public async Task Get_SeedsConfiguredDefaultsAndPublishesSnapshot()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-pre-download-");
        try
        {
            var dbOptions = Options(directory);
            await using (var setup = new StreamarrDbContext(dbOptions))
                await setup.Database.EnsureCreatedAsync();

            var live = new PreDownloadOptions
            {
                Enabled = true,
                DownloadCurrentFile = false,
                CurrentFileThresholdSeconds = 42,
                DownloadNextEpisode = true,
                NextEpisodeThresholdPercent = 80,
                MaxConcurrentDownloads = 3,
            };
            var service = new PreDownloadConfigService(new Factory(dbOptions), live);

            var snapshot = await service.GetAsync(default);

            Assert.Equal(snapshot, service.Current);
            Assert.True(snapshot.Enabled);
            Assert.False(snapshot.DownloadCurrentFile);
            Assert.Equal(42, snapshot.CurrentFileThresholdSeconds);
            Assert.True(snapshot.DownloadNextEpisode);
            Assert.Equal(80, snapshot.NextEpisodeThresholdPercent);
            Assert.Equal(3, snapshot.MaxConcurrentDownloads);

            await using var db = new StreamarrDbContext(dbOptions);
            var stored = await db.PreDownloadConfig.AsNoTracking().SingleAsync(x => x.Id == 1);
            Assert.Equal(42, stored.CurrentFileThresholdSeconds);
            Assert.Equal(80, stored.NextEpisodeThresholdPercent);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task PartialUpdates_PreserveOmittedValuesAndUpdateLiveState()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-pre-download-");
        try
        {
            var dbOptions = Options(directory);
            await using (var setup = new StreamarrDbContext(dbOptions))
                await setup.Database.EnsureCreatedAsync();

            var live = new PreDownloadOptions();
            var service = new PreDownloadConfigService(new Factory(dbOptions), live);
            await service.GetAsync(default);

            await service.UpdateAsync(new PreDownloadConfigWrite
            {
                Enabled = true,
                DownloadCurrentFile = false,
                CurrentFileThresholdSeconds = 25,
            }, default);
            await service.UpdateAsync(new PreDownloadConfigWrite
            {
                NextEpisodeThresholdPercent = 90,
                MaxConcurrentDownloads = 4,
            }, default);

            var snapshot = service.Current;
            Assert.True(snapshot.Enabled);
            Assert.False(snapshot.DownloadCurrentFile);
            Assert.Equal(25, snapshot.CurrentFileThresholdSeconds);
            Assert.True(snapshot.DownloadNextEpisode);
            Assert.Equal(90, snapshot.NextEpisodeThresholdPercent);
            Assert.Equal(4, snapshot.MaxConcurrentDownloads);
            Assert.Equal(snapshot.Enabled, live.Enabled);
            Assert.Equal(snapshot.MaxConcurrentDownloads, live.MaxConcurrentDownloads);

            await using var db = new StreamarrDbContext(dbOptions);
            var stored = await db.PreDownloadConfig.AsNoTracking().SingleAsync(x => x.Id == 1);
            Assert.True(stored.Enabled);
            Assert.False(stored.DownloadCurrentFile);
            Assert.Equal(25, stored.CurrentFileThresholdSeconds);
            Assert.True(stored.DownloadNextEpisode);
            Assert.Equal(90, stored.NextEpisodeThresholdPercent);
            Assert.Equal(4, stored.MaxConcurrentDownloads);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    private static DbContextOptions<StreamarrDbContext> Options(DirectoryInfo directory)
        => new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(directory.FullName, "config.db")}")
            .Options;

    private sealed class Factory(DbContextOptions<StreamarrDbContext> options)
        : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);

        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(CreateDbContext());
    }
}
