using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Providers;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Config;

/// <summary>
/// SQLite-backed Usenet provider config (BRIEF §6.3, DECISIONS.md #6 — multiple,
/// priority-ordered). Source of truth for the config API, the NNTP pool built at
/// startup, and provider reachability in /health. A singleton over
/// <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class ProviderConfigService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector,
    MultiProviderNntpClient livePool,
    ILoggerFactory loggerFactory)
{
    public async Task<IReadOnlyList<ProviderEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Providers.AsNoTracking().OrderBy(p => p.Priority).ThenBy(p => p.Name).ToListAsync(ct);
    }

    public async Task<ProviderEntity?> GetAsync(string id, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Providers.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);
    }

    public async Task<ProviderEntity> CreateAsync(ProviderWrite write, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = new ProviderEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            Name = write.Name,
            Host = write.Host,
            Port = write.Port ?? 563,
            UseSsl = write.UseSsl ?? true,
            Username = write.Username ?? string.Empty,
            PasswordEncrypted = SecretMasking.IsOmitted(write.Password) ? null : protector.Protect(write.Password),
            MaxConnections = write.MaxConnections ?? 10,
            Priority = write.Priority ?? 0,
            Enabled = write.Enabled ?? true,
            IsBackupOnly = write.IsBackupOnly ?? false,
        };
        db.Providers.Add(entity);
        await db.SaveChangesAsync(ct);
        await ReloadPoolAsync(ct);
        return entity;
    }

    public async Task<ProviderEntity?> UpdateAsync(string id, ProviderWrite write, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Providers.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (entity is null)
            return null;

        entity.Name = write.Name;
        entity.Host = write.Host;
        entity.Port = write.Port ?? entity.Port;
        entity.UseSsl = write.UseSsl ?? entity.UseSsl;
        entity.Username = write.Username ?? entity.Username;
        entity.MaxConnections = write.MaxConnections ?? entity.MaxConnections;
        entity.Priority = write.Priority ?? entity.Priority;
        entity.Enabled = write.Enabled ?? entity.Enabled;
        entity.IsBackupOnly = write.IsBackupOnly ?? entity.IsBackupOnly;

        if (!SecretMasking.IsOmitted(write.Password))
            entity.PasswordEncrypted = protector.Protect(write.Password);

        await db.SaveChangesAsync(ct);
        await ReloadPoolAsync(ct);
        return entity;
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Providers.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (entity is null)
            return false;

        db.Providers.Remove(entity);
        await db.SaveChangesAsync(ct);
        await ReloadPoolAsync(ct);
        return true;
    }

    public async Task<bool> ReorderAsync(IReadOnlyList<string> ids, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var rows = await db.Providers.ToListAsync(ct);
        if (ids.Count != rows.Count || ids.Distinct(StringComparer.Ordinal).Count() != ids.Count ||
            !rows.Select(x => x.Id).ToHashSet(StringComparer.Ordinal).SetEquals(ids))
        {
            return false;
        }

        var byId = rows.ToDictionary(x => x.Id, StringComparer.Ordinal);
        for (var priority = 0; priority < ids.Count; priority++)
            byId[ids[priority]].Priority = priority;

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        await ReloadPoolAsync(ct);
        return true;
    }

    /// <summary>Decrypted provider (used by the /test endpoint and pool wiring).</summary>
    public UsenetProvider ToProvider(ProviderEntity e) => new()
    {
        Name = e.Name,
        Host = e.Host,
        Port = e.Port,
        UseSsl = e.UseSsl,
        Username = e.Username,
        Password = protector.Unprotect(e.PasswordEncrypted),
        MaxConnections = e.MaxConnections,
        Priority = e.Priority,
        Type = e.IsBackupOnly ? UsenetProviderType.BackupOnly : UsenetProviderType.Pooled,
    };

    private async Task ReloadPoolAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var rows = await db.Providers.AsNoTracking()
            .Where(p => p.Enabled)
            .OrderBy(p => p.Priority)
            .ThenBy(p => p.Name)
            .ToListAsync(ct);
        var clients = rows
            .Select(ToProvider)
            .Select(p => UsenetStreamingClient.CreateProviderClient(p, loggerFactory))
            .ToList();
        livePool.ReplaceProviders(clients);
    }
}

/// <summary>Write model for provider create/update. Secret <see cref="Password"/> is write-only.</summary>
public sealed record ProviderWrite
{
    public string? Id { get; init; }
    public required string Name { get; init; }
    public required string Host { get; init; }
    public int? Port { get; init; }
    public bool? UseSsl { get; init; }
    public string? Username { get; init; }
    public string? Password { get; init; }
    public int? MaxConnections { get; init; }
    public int? Priority { get; init; }
    public bool? Enabled { get; init; }
    public bool? IsBackupOnly { get; init; }
}
