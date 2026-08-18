using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>Immutable policy consumed by progress-triggered background work.</summary>
public sealed record PreDownloadConfigSnapshot(
    bool Enabled,
    bool DownloadCurrentFile,
    int CurrentFileThresholdSeconds,
    bool DownloadNextEpisode,
    int NextEpisodeThresholdPercent,
    int MaxConcurrentDownloads);

/// <summary>SQLite-backed pre-download config with an atomically published live snapshot.</summary>
public sealed class PreDownloadConfigService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    PreDownloadOptions liveOptions)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private PreDownloadConfigSnapshot _current = FromOptions(liveOptions);

    public PreDownloadConfigSnapshot Current => Volatile.Read(ref _current);

    public async Task<PreDownloadConfigSnapshot> GetAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            return Publish(await LoadAsync(db, ct));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PreDownloadConfigSnapshot> UpdateAsync(
        PreDownloadConfigWrite write,
        CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await LoadAsync(db, ct);

            if (write.Enabled is { } enabled) entity.Enabled = enabled;
            if (write.DownloadCurrentFile is { } current) entity.DownloadCurrentFile = current;
            if (write.CurrentFileThresholdSeconds is { } currentThreshold)
                entity.CurrentFileThresholdSeconds = currentThreshold;
            if (write.DownloadNextEpisode is { } next) entity.DownloadNextEpisode = next;
            if (write.NextEpisodeThresholdPercent is { } nextThreshold)
                entity.NextEpisodeThresholdPercent = nextThreshold;
            if (write.MaxConcurrentDownloads is { } concurrency)
                entity.MaxConcurrentDownloads = concurrency;

            await db.SaveChangesAsync(ct);
            return Publish(entity);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal void ApplyPersisted(PreDownloadConfigEntity entity) => Publish(entity);

    internal static PreDownloadConfigEntity FromOptionsEntity(PreDownloadOptions options) => new()
    {
        Id = 1,
        Enabled = options.Enabled,
        DownloadCurrentFile = options.DownloadCurrentFile,
        CurrentFileThresholdSeconds = options.CurrentFileThresholdSeconds,
        DownloadNextEpisode = options.DownloadNextEpisode,
        NextEpisodeThresholdPercent = options.NextEpisodeThresholdPercent,
        MaxConcurrentDownloads = options.MaxConcurrentDownloads,
    };

    private async Task<PreDownloadConfigEntity> LoadAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var entity = await db.PreDownloadConfig.SingleOrDefaultAsync(x => x.Id == 1, ct);
        if (entity is not null)
            return entity;

        entity = FromOptionsEntity(liveOptions);
        db.PreDownloadConfig.Add(entity);
        await db.SaveChangesAsync(ct);
        return entity;
    }

    private PreDownloadConfigSnapshot Publish(PreDownloadConfigEntity entity)
    {
        var snapshot = new PreDownloadConfigSnapshot(
            entity.Enabled,
            entity.DownloadCurrentFile,
            entity.CurrentFileThresholdSeconds,
            entity.DownloadNextEpisode,
            entity.NextEpisodeThresholdPercent,
            entity.MaxConcurrentDownloads);

        liveOptions.Enabled = snapshot.Enabled;
        liveOptions.DownloadCurrentFile = snapshot.DownloadCurrentFile;
        liveOptions.CurrentFileThresholdSeconds = snapshot.CurrentFileThresholdSeconds;
        liveOptions.DownloadNextEpisode = snapshot.DownloadNextEpisode;
        liveOptions.NextEpisodeThresholdPercent = snapshot.NextEpisodeThresholdPercent;
        liveOptions.MaxConcurrentDownloads = snapshot.MaxConcurrentDownloads;
        Volatile.Write(ref _current, snapshot);
        return snapshot;
    }

    private static PreDownloadConfigSnapshot FromOptions(PreDownloadOptions options) => new(
        options.Enabled,
        options.DownloadCurrentFile,
        options.CurrentFileThresholdSeconds,
        options.DownloadNextEpisode,
        options.NextEpisodeThresholdPercent,
        options.MaxConcurrentDownloads);
}
