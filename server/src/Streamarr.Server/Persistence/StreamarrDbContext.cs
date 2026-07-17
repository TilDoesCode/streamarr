using Microsoft.EntityFrameworkCore;
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
    public DbSet<NotificationConfigEntity> NotificationConfig => Set<NotificationConfigEntity>();
    public DbSet<WatchEventEntity> WatchEvents => Set<WatchEventEntity>();
    public DbSet<CachedReleaseEntity> CachedReleases => Set<CachedReleaseEntity>();
    public DbSet<ApiKeyEntity> ApiKeys => Set<ApiKeyEntity>();
    public DbSet<UserEntity> Users => Set<UserEntity>();

    protected override void OnModelCreating(ModelBuilder model)
    {
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
        model.Entity<NotificationConfigEntity>(e => e.HasKey(x => x.Id));

        model.Entity<WatchEventEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ReleaseId);
            e.HasIndex(x => x.ReceivedAt);
            e.HasIndex(x => x.PlaybackSessionId);
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
    }
}
