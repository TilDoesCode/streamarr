using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Config;

/// <summary>
/// SQLite-backed general configuration (BRIEF §6.3): TMDB key, TTLs, cache sizes, and
/// the global NNTP connection budget, stored as a single row. Source of truth read at
/// startup to seed the running options; the TMDB key is encrypted at rest.
/// </summary>
public sealed class GeneralConfigService(IDbContextFactory<StreamarrDbContext> dbFactory, ISecretProtector protector)
{
    public async Task<GeneralConfigEntity> GetAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await LoadAsync(db, ct);
    }

    public async Task<GeneralConfigEntity> UpdateAsync(GeneralConfigWrite write, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = await LoadAsync(db, ct);

        if (write.SessionTtlSeconds is { } ttl) entity.SessionTtlSeconds = ttl;
        if (write.SearchCacheTtlSeconds is { } sc) entity.SearchCacheTtlSeconds = sc;
        if (write.SegmentCacheSizeMb is { } sz) entity.SegmentCacheSizeMb = sz;
        if (write.ConnectionBudget is { } budget) entity.ConnectionBudget = budget;

        // Omit-to-keep for the secret TMDB key.
        if (!SecretMasking.IsOmitted(write.TmdbApiKey))
            entity.TmdbApiKeyEncrypted = protector.Protect(write.TmdbApiKey);

        await db.SaveChangesAsync(ct);
        return entity;
    }

    private static async Task<GeneralConfigEntity> LoadAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var entity = await db.GeneralConfig.SingleOrDefaultAsync(g => g.Id == 1, ct);
        if (entity is null)
        {
            entity = new GeneralConfigEntity { Id = 1 };
            db.GeneralConfig.Add(entity);
            await db.SaveChangesAsync(ct);
        }

        return entity;
    }
}

/// <summary>Write model for general config. Secret <see cref="TmdbApiKey"/> is write-only.</summary>
public sealed record GeneralConfigWrite
{
    public string? TmdbApiKey { get; init; }
    public int? SessionTtlSeconds { get; init; }
    public int? SearchCacheTtlSeconds { get; init; }
    public int? SegmentCacheSizeMb { get; init; }
    public int? ConnectionBudget { get; init; }
}
