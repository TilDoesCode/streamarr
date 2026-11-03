using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Tunnels;

/// <summary>Outcome of a tunnel delete.</summary>
public enum TunnelDeleteOutcome
{
    Deleted,
    NotFound,

    /// <summary>Providers or indexers still route through the tunnel and <c>force</c> was not set.</summary>
    InUse,
}

/// <summary>
/// SQLite-backed tunnel config (docs/vpn.md). Private and preshared keys are encrypted at rest exactly like provider
/// passwords and are only decrypted for the helper process. A singleton over <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class TunnelConfigService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector,
    TimeProvider time)
{
    /// <summary>Loopback port range reserved for tunnel SOCKS5 proxies; one fixed port per tunnel.</summary>
    public const int FirstLocalPort = 41800;
    public const int LastLocalPort = 41899;

    public async Task<IReadOnlyList<TunnelEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Tunnels.AsNoTracking().OrderBy(t => t.Name).ThenBy(t => t.Id).ToListAsync(ct);
    }

    public async Task<TunnelEntity?> GetAsync(string id, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Tunnels.AsNoTracking().FirstOrDefaultAsync(t => t.Id == id, ct);
    }

    public async Task<bool> ExistsAsync(string id, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Tunnels.AsNoTracking().AnyAsync(t => t.Id == id, ct);
    }

    /// <summary>Tunnel id → name, for route descriptions of many providers/indexers in one query.</summary>
    public async Task<IReadOnlyDictionary<string, string>> NameMapAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.Tunnels.AsNoTracking().ToDictionaryAsync(t => t.Id, t => t.Name, StringComparer.Ordinal, ct);
    }

    /// <summary>Creates a tunnel from validated settings and assigns its fixed loopback port.</summary>
    /// <exception cref="InvalidOperationException">No port is free, i.e. 100 tunnels already exist.</exception>
    public async Task<TunnelEntity> CreateAsync(NormalizedTunnel settings, bool enabled, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var used = await db.Tunnels.AsNoTracking().Select(t => t.LocalPort).ToListAsync(ct);
            var port = Enumerable.Range(FirstLocalPort, LastLocalPort - FirstLocalPort + 1).FirstOrDefault(p => !used.Contains(p));
            if (port == 0)
                throw new InvalidOperationException($"At most {LastLocalPort - FirstLocalPort + 1} tunnels are supported.");

            var now = time.GetUtcNow();
            var entity = new TunnelEntity
            {
                Id = Guid.NewGuid().ToString("n"),
                LocalPort = port,
                CreatedAt = now,
                UpdatedAt = now,
                Enabled = enabled,
            };
            Apply(entity, settings);
            entity.PrivateKeyEncrypted = protector.Protect(settings.PrivateKey);
            entity.PresharedKeyEncrypted = protector.Protect(settings.PresharedKey);
            db.Tunnels.Add(entity);
            try
            {
                await db.SaveChangesAsync(ct);
                return entity;
            }
            catch (DbUpdateException) when (attempt < 3)
            {
                // Two concurrent creates picked the same port; the unique index rejected one of them.
            }
        }
    }

    /// <summary>
    /// Replaces the stored settings; a null <see cref="NormalizedTunnel.PrivateKey"/> keeps the stored key, a null
    /// preshared key keeps it and <paramref name="clearPresharedKey"/> removes it.
    /// </summary>
    public async Task<TunnelEntity?> UpdateAsync(string id, NormalizedTunnel settings, bool? enabled, bool clearPresharedKey, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Tunnels.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (entity is null)
            return null;

        Apply(entity, settings);
        entity.Enabled = enabled ?? entity.Enabled;
        entity.UpdatedAt = time.GetUtcNow();
        if (settings.PrivateKey is not null)
            entity.PrivateKeyEncrypted = protector.Protect(settings.PrivateKey);
        if (settings.PresharedKey is not null)
            entity.PresharedKeyEncrypted = protector.Protect(settings.PresharedKey);
        else if (clearPresharedKey)
            entity.PresharedKeyEncrypted = null;

        await db.SaveChangesAsync(ct);
        return entity;
    }

    /// <summary>Deletes a tunnel; with <paramref name="force"/> dependent providers and indexers are set to direct first.</summary>
    public async Task<(TunnelDeleteOutcome Outcome, TunnelUsage Usage)> DeleteAsync(string id, bool force, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var entity = await db.Tunnels.FirstOrDefaultAsync(t => t.Id == id, ct);
        if (entity is null)
            return (TunnelDeleteOutcome.NotFound, TunnelUsage.Empty);

        var providers = await db.Providers.Where(p => p.TunnelId == id).OrderBy(p => p.Priority).ThenBy(p => p.Name).ToListAsync(ct);
        var indexers = await db.Indexers.Where(i => i.TunnelId == id).OrderBy(i => i.Priority).ThenBy(i => i.Name).ToListAsync(ct);
        var usage = new TunnelUsage
        {
            Providers = providers.Select(p => new TunnelUsageRef { Id = p.Id, Name = p.Name }).ToList(),
            Indexers = indexers.Select(i => new TunnelUsageRef { Id = i.Id, Name = i.Name }).ToList(),
        };
        if (usage.Any && !force)
            return (TunnelDeleteOutcome.InUse, usage);

        foreach (var provider in providers)
            provider.TunnelId = null;
        foreach (var indexer in indexers)
            indexer.TunnelId = null;
        db.Tunnels.Remove(entity);
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return (TunnelDeleteOutcome.Deleted, usage);
    }

    public async Task<TunnelUsage> UsageAsync(string id, CancellationToken ct)
    {
        var map = await UsageMapAsync(ct);
        return map.TryGetValue(id, out var usage) ? usage : TunnelUsage.Empty;
    }

    /// <summary>Tunnel id → the providers and indexers routed through it (tunnels without users are absent).</summary>
    public async Task<IReadOnlyDictionary<string, TunnelUsage>> UsageMapAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var providers = await db.Providers.AsNoTracking()
            .Where(p => p.TunnelId != null)
            .OrderBy(p => p.Priority).ThenBy(p => p.Name)
            .Select(p => new { p.TunnelId, p.Id, p.Name })
            .ToListAsync(ct);
        var indexers = await db.Indexers.AsNoTracking()
            .Where(i => i.TunnelId != null)
            .OrderBy(i => i.Priority).ThenBy(i => i.Name)
            .Select(i => new { i.TunnelId, i.Id, i.Name })
            .ToListAsync(ct);

        var result = new Dictionary<string, TunnelUsage>(StringComparer.Ordinal);
        foreach (var tunnelId in providers.Select(p => p.TunnelId!).Concat(indexers.Select(i => i.TunnelId!)).Distinct(StringComparer.Ordinal))
        {
            result[tunnelId] = new TunnelUsage
            {
                Providers = providers.Where(p => p.TunnelId == tunnelId).Select(p => new TunnelUsageRef { Id = p.Id, Name = p.Name }).ToList(),
                Indexers = indexers.Where(i => i.TunnelId == tunnelId).Select(i => new TunnelUsageRef { Id = i.Id, Name = i.Name }).ToList(),
            };
        }
        return result;
    }

    /// <summary>Decrypted private key for the helper process; empty when none is stored or the key ring was lost.</summary>
    public string PrivateKey(TunnelEntity entity) => protector.Unprotect(entity.PrivateKeyEncrypted);

    /// <summary>Decrypted preshared key for the helper process; empty when none is stored.</summary>
    public string PresharedKey(TunnelEntity entity) => protector.Unprotect(entity.PresharedKeyEncrypted);

    /// <summary>The public key matching the stored private key; null without a usable private key.</summary>
    public string? PublicKey(TunnelEntity entity) => WireGuardKeys.PublicKeyOf(PrivateKey(entity));

    public TunnelResponse ToResponse(TunnelEntity e, TunnelStatus status, TunnelUsage usage) => new()
    {
        Id = e.Id,
        Name = e.Name,
        Preset = e.Preset,
        Enabled = e.Enabled,
        Endpoint = e.Endpoint,
        Addresses = ParseList(e.Addresses),
        Dns = ParseList(e.Dns),
        Mtu = e.Mtu,
        Keepalive = e.Keepalive,
        PeerPublicKey = e.PeerPublicKey,
        HasPrivateKey = !string.IsNullOrEmpty(e.PrivateKeyEncrypted),
        PublicKey = PublicKey(e),
        HasPresharedKey = !string.IsNullOrEmpty(e.PresharedKeyEncrypted),
        AllowedIps = ParseList(e.AllowedIps),
        Status = status,
        UsedBy = usage,
    };

    internal static string JoinList(IReadOnlyList<string> values) => string.Join(',', values);

    internal static IReadOnlyList<string> ParseList(string csv)
        => string.IsNullOrWhiteSpace(csv) ? [] : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static void Apply(TunnelEntity entity, NormalizedTunnel settings)
    {
        entity.Name = settings.Name;
        entity.Preset = settings.Preset;
        entity.Endpoint = settings.Endpoint;
        entity.Addresses = JoinList(settings.Addresses);
        entity.Dns = JoinList(settings.Dns);
        entity.Mtu = settings.Mtu;
        entity.Keepalive = settings.Keepalive;
        entity.PeerPublicKey = settings.PeerPublicKey;
        entity.AllowedIps = JoinList(settings.AllowedIps);
    }
}
