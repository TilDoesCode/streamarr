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
    public DbSet<WatchEventEntity> WatchEvents => Set<WatchEventEntity>();
    public DbSet<ApiKeyEntity> ApiKeys => Set<ApiKeyEntity>();

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

        model.Entity<WatchEventEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.ReleaseId);
            e.HasIndex(x => x.ReceivedAt);
        });

        model.Entity<ApiKeyEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.KeyHash).IsUnique();
        });
    }
}
