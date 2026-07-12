using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Config;

/// <summary>
/// One-shot startup routine (called from <c>UseStreamarrServer</c> before the pipeline
/// starts): applies EF Core migrations, seeds the database from
/// <see cref="StreamarrOptions"/> on first run, and overlays the effective persisted
/// config (providers, connection budget, TTLs, TMDB key) back onto the running options
/// so the rest of the app treats the database as the source of truth (BRIEF §6.3).
/// </summary>
public sealed class StreamarrDbInitializer(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    IOptions<StreamarrOptions> options,
    ISecretProtector protector)
{
    public void Initialize()
    {
        using var db = dbFactory.CreateDbContext();
        db.Database.Migrate();

        SeedIfEmpty(db);
        Overlay(db);
    }

    /// <summary>Seed config tables from options the first time the DB is created.</summary>
    private void SeedIfEmpty(StreamarrDbContext db)
    {
        var opts = options.Value;

        if (!db.Indexers.Any() && opts.Indexers.Count > 0)
        {
            foreach (var i in opts.Indexers)
            {
                db.Indexers.Add(new IndexerEntity
                {
                    Id = string.IsNullOrWhiteSpace(i.Id) ? (string.IsNullOrWhiteSpace(i.Name) ? Guid.NewGuid().ToString("n") : i.Name) : i.Id,
                    Name = i.Name,
                    BaseUrl = i.BaseUrl,
                    ApiKeyEncrypted = protector.Protect(i.ApiKey),
                    Categories = IndexerConfigService.JoinCategories(i.Categories),
                    Enabled = i.Enabled,
                    Priority = i.Priority,
                });
            }
        }

        if (!db.Providers.Any() && opts.Providers.Count > 0)
        {
            foreach (var p in opts.Providers)
            {
                db.Providers.Add(new ProviderEntity
                {
                    Id = string.IsNullOrWhiteSpace(p.Name) ? Guid.NewGuid().ToString("n") : p.Name,
                    Name = p.Name,
                    Host = p.Host,
                    Port = p.Port,
                    UseSsl = p.UseSsl,
                    Username = p.Username,
                    PasswordEncrypted = protector.Protect(p.Password),
                    MaxConnections = p.MaxConnections,
                    Priority = p.Priority,
                    Enabled = p.Type != Usenet.Models.UsenetProviderType.Disabled,
                    IsBackupOnly = p.Type == Usenet.Models.UsenetProviderType.BackupOnly,
                });
            }
        }

        if (!db.GeneralConfig.Any())
        {
            db.GeneralConfig.Add(new GeneralConfigEntity
            {
                Id = 1,
                TmdbApiKeyEncrypted = protector.Protect(opts.Tmdb.ApiKey),
                SessionTtlSeconds = opts.SessionTtlSeconds,
                SearchCacheTtlSeconds = opts.Search.SearchCacheTtlSeconds,
                ConnectionBudget = opts.ConnectionBudget,
            });
        }

        db.SaveChanges();
    }

    /// <summary>
    /// Make the persisted config authoritative for the running app by mutating the
    /// options instance in place (all singletons resolve lazily, after this runs).
    /// </summary>
    private void Overlay(StreamarrDbContext db)
    {
        var opts = options.Value;

        var general = db.GeneralConfig.AsNoTracking().FirstOrDefault();
        if (general is not null)
        {
            opts.ConnectionBudget = general.ConnectionBudget;
            opts.SessionTtlSeconds = general.SessionTtlSeconds;
            opts.Search.SearchCacheTtlSeconds = general.SearchCacheTtlSeconds;

            var tmdbKey = protector.Unprotect(general.TmdbApiKeyEncrypted);
            if (!string.IsNullOrEmpty(tmdbKey))
                opts.Tmdb.ApiKey = tmdbKey;
        }

        // Rebuild the provider list the NNTP pool is constructed from (M7 makes live
        // rebuild additive; for now the pool reads this at first-request resolve).
        var providers = db.Providers.AsNoTracking()
            .Where(p => p.Enabled)
            .OrderBy(p => p.Priority)
            .ThenBy(p => p.Name)
            .ToList();

        opts.Providers = providers.Select(p => new UsenetProviderOptions
        {
            Name = p.Name,
            Host = p.Host,
            Port = p.Port,
            UseSsl = p.UseSsl,
            Username = p.Username,
            Password = protector.Unprotect(p.PasswordEncrypted),
            MaxConnections = p.MaxConnections,
            Priority = p.Priority,
            Type = p.IsBackupOnly ? Usenet.Models.UsenetProviderType.BackupOnly : Usenet.Models.UsenetProviderType.Pooled,
        }).ToList();
    }
}
