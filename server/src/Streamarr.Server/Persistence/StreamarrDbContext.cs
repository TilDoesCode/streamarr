using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Persistence;

/// <summary>
/// EF Core / SQLite persistence for the Core Server's configuration and watch state
/// (BRIEF §4, §6.3). Secrets are stored only as Data-Protection ciphertext columns;
/// see the config services for encrypt-on-write / mask-on-read handling.
/// </summary>
public sealed class StreamarrDbContext(DbContextOptions<StreamarrDbContext> options) : DbContext(options)
{
    public DbSet<IndexerEntity> Indexers => Set<IndexerEntity>();
    public DbSet<ProviderEntity> Providers => Set<ProviderEntity>();
    public DbSet<ProfileEntity> Profiles => Set<ProfileEntity>();
    public DbSet<GeneralConfigEntity> GeneralConfig => Set<GeneralConfigEntity>();
    public DbSet<PreDownloadConfigEntity> PreDownloadConfig => Set<PreDownloadConfigEntity>();
    public DbSet<NotificationConfigEntity> NotificationConfig => Set<NotificationConfigEntity>();
    public DbSet<TranscodingConfigEntity> TranscodingConfig => Set<TranscodingConfigEntity>();
    public DbSet<WatchEventEntity> WatchEvents => Set<WatchEventEntity>();
    public DbSet<PlaybackRangeEntity> PlaybackRanges => Set<PlaybackRangeEntity>();
    public DbSet<CachedReleaseEntity> CachedReleases => Set<CachedReleaseEntity>();
    public DbSet<ApiKeyEntity> ApiKeys => Set<ApiKeyEntity>();
    public DbSet<UserEntity> Users => Set<UserEntity>();
    public DbSet<AdminRefreshSessionEntity> AdminRefreshSessions => Set<AdminRefreshSessionEntity>();
    public DbSet<StreamRecordEntity> StreamRecords => Set<StreamRecordEntity>();
    public DbSet<StreamEventEntity> StreamEvents => Set<StreamEventEntity>();
    public DbSet<ViewerConfigEntity> ViewerConfig => Set<ViewerConfigEntity>();
    public DbSet<ViewerEntity> Viewers => Set<ViewerEntity>();
    public DbSet<ViewerSessionEntity> ViewerSessions => Set<ViewerSessionEntity>();
    public DbSet<ViewerSessionTombstoneEntity> ViewerSessionTombstones => Set<ViewerSessionTombstoneEntity>();
    public DbSet<ViewerOneTimeCodeEntity> ViewerOneTimeCodes => Set<ViewerOneTimeCodeEntity>();
    public DbSet<ViewerRecoveryCodeEntity> ViewerRecoveryCodes => Set<ViewerRecoveryCodeEntity>();
    public DbSet<ViewerWatchStateEntity> ViewerWatchStates => Set<ViewerWatchStateEntity>();
    public DbSet<ArtworkPaletteEntity> ArtworkPalettes => Set<ArtworkPaletteEntity>();
    public DbSet<CatalogSpecSummaryEntity> CatalogSpecSummaries => Set<CatalogSpecSummaryEntity>();
    public DbSet<ReleaseContainerEntity> ReleaseContainers => Set<ReleaseContainerEntity>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        ConfigureViewers(model);

        model.Entity<IndexerEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
        });

        model.Entity<ProviderEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
        });

        model.Entity<ProfileEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
        });

        model.Entity<GeneralConfigEntity>(e => e.HasKey(x => x.Id));
        model.Entity<PreDownloadConfigEntity>(e => e.HasKey(x => x.Id));
        model.Entity<NotificationConfigEntity>(e => e.HasKey(x => x.Id));
        model.Entity<TranscodingConfigEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.SettingsJson).IsRequired();
        });

        model.Entity<WatchEventEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ReleaseId);
            e.HasIndex(x => x.ReceivedAt);
            e.HasIndex(x => x.PlaybackSessionId);
        });

        model.Entity<PlaybackRangeEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ScopeKey).IsUnique();
            e.HasIndex(x => x.WorkId);
            e.HasIndex(x => x.UpdatedAt);
        });

        model.Entity<CachedReleaseEntity>(e =>
        {
            e.HasKey(x => x.ReleaseId);
            e.HasIndex(x => x.LastAccessedAt);
            e.Property(x => x.Title).IsRequired();
            e.Property(x => x.CacheFileName).IsRequired();
        });

        model.Entity<ApiKeyEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.KeyHash).IsUnique();
        });

        model.Entity<UserEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Username).IsRequired();
            e.HasIndex(x => x.Username).IsUnique();
        });

        model.Entity<AdminRefreshSessionEntity>(e =>
        {
            e.HasKey(x => x.TokenHash);
            e.HasIndex(x => x.UserId);
            e.HasIndex(x => x.ExpiresAt);
        });

        model.Entity<StreamRecordEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.AttemptId).IsUnique();
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.CreatedAt);
            e.HasIndex(x => x.FinalState);
            e.Property(x => x.AttemptId).IsRequired();
            e.HasMany(x => x.Events)
                .WithOne()
                .HasForeignKey(x => x.StreamRecordId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        model.Entity<StreamEventEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.StreamRecordId);
        });
    }

    private static void ConfigureViewers(ModelBuilder model)
    {
        model.Entity<ViewerConfigEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.SettingsJson).IsRequired();
        });

        model.Entity<ViewerEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Username).IsRequired();
            e.Property(x => x.NormalizedUsername).IsRequired();
            e.HasIndex(x => x.NormalizedUsername).IsUnique();
            e.HasIndex(x => x.NormalizedEmail).IsUnique();
        });

        model.Entity<ViewerSessionEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.AccessTokenHash).IsUnique();
            e.HasIndex(x => x.RefreshTokenHash).IsUnique();
            e.HasIndex(x => x.PreviousRefreshTokenHash);
            e.HasIndex(x => x.ViewerId);
            e.HasOne<ViewerEntity>().WithMany().HasForeignKey(x => x.ViewerId).OnDelete(DeleteBehavior.Cascade);
        });

        model.Entity<ViewerSessionTombstoneEntity>(e =>
        {
            e.HasKey(x => x.RefreshTokenHash);
            e.HasIndex(x => x.ExpiresAt);
        });

        model.Entity<ViewerOneTimeCodeEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.ViewerId, x.Purpose });
            e.HasOne<ViewerEntity>().WithMany().HasForeignKey(x => x.ViewerId).OnDelete(DeleteBehavior.Cascade);
        });

        model.Entity<ViewerRecoveryCodeEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ViewerId);
            e.HasOne<ViewerEntity>().WithMany().HasForeignKey(x => x.ViewerId).OnDelete(DeleteBehavior.Cascade);
        });

        model.Entity<ViewerWatchStateEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.WorkId).IsRequired();
            e.HasIndex(x => new { x.ViewerId, x.WorkId }).IsUnique();
            e.HasIndex(x => new { x.ViewerId, x.LastPlayedAt });
            e.HasIndex(x => new { x.ViewerId, x.SeriesWorkId });
            e.HasOne<ViewerEntity>().WithMany().HasForeignKey(x => x.ViewerId).OnDelete(DeleteBehavior.Cascade);
        });

        model.Entity<ArtworkPaletteEntity>(e => e.HasKey(x => x.ImageUrl));
        model.Entity<CatalogSpecSummaryEntity>(e => e.HasKey(x => x.WorkId));
        model.Entity<ReleaseContainerEntity>(e =>
        {
            e.HasKey(x => x.ReleaseId);
            e.HasIndex(x => x.LastUsedAt);
        });

        // Unix milliseconds keep expiry and ordering predicates translatable on SQLite.
        var unixMilliseconds = new ValueConverter<DateTimeOffset, long>(
            value => value.ToUnixTimeMilliseconds(),
            value => DateTimeOffset.FromUnixTimeMilliseconds(value));
        Type[] viewerTables =
        [
            typeof(ViewerConfigEntity), typeof(ViewerEntity), typeof(ViewerSessionEntity), typeof(ViewerSessionTombstoneEntity),
            typeof(ViewerOneTimeCodeEntity), typeof(ViewerRecoveryCodeEntity), typeof(ViewerWatchStateEntity),
            typeof(ArtworkPaletteEntity), typeof(CatalogSpecSummaryEntity), typeof(ReleaseContainerEntity),
        ];
        foreach (var table in viewerTables)
        {
            foreach (var property in model.Entity(table).Metadata.GetProperties()
                         .Where(p => p.ClrType == typeof(DateTimeOffset) || p.ClrType == typeof(DateTimeOffset?)))
            {
                property.SetValueConverter(unixMilliseconds);
            }
        }
    }
}
