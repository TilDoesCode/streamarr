using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Config;

/// <summary>
/// SQLite-backed general configuration (BRIEF §6.3): TMDB key, TTLs, cache sizes, and
/// the global NNTP connection budget, stored as a single row. Source of truth read at
/// startup to seed the running options; the TMDB key is encrypted at rest.
/// </summary>
public sealed class GeneralConfigService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector,
    TmdbOptions liveTmdbOptions)
{
    private readonly SemaphoreSlim _updateGate = new(1, 1);

    public async Task<GeneralConfigEntity> GetAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await LoadAsync(db, ct);
    }

    public async Task<GeneralConfigEntity> UpdateAsync(GeneralConfigWrite write, CancellationToken ct)
    {
        await _updateGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await LoadAsync(db, ct);

            if (write.SessionTtlSeconds is { } ttl) entity.SessionTtlSeconds = ttl;
            if (write.EphemeralCacheSizeMb is { } ephemeralSize) entity.EphemeralCacheSizeMb = ephemeralSize;
            if (write.SearchCacheTtlSeconds is { } sc) entity.SearchCacheTtlSeconds = sc;
            if (write.SegmentCacheSizeMb is { } sz) entity.SegmentCacheSizeMb = sz;
            if (write.ConnectionBudget is { } budget) entity.ConnectionBudget = budget;
            if (write.AddStreamarrBadge is { } badge) entity.AddStreamarrBadge = badge;
            if (write.AddReleaseScoreToName is { } score) entity.AddReleaseScoreToName = score;

            // Omit-to-keep for the secret TMDB key.
            string? replacementCredential = null;
            if (!SecretMasking.IsOmitted(write.TmdbApiKey))
            {
                replacementCredential = TmdbOptions.NormalizeCredential(write.TmdbApiKey);
                entity.TmdbApiKeyEncrypted = protector.Protect(replacementCredential);
            }

            await db.SaveChangesAsync(ct);

            // The TMDB client shares this options instance. Keep the durable commit and
            // live assignment in the same serialized operation so concurrent PUTs cannot
            // commit credential B and then overwrite the process with credential A.
            if (replacementCredential is not null)
                liveTmdbOptions.ApiKey = replacementCredential;

            return entity;
        }
        finally
        {
            _updateGate.Release();
        }
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
    public int? EphemeralCacheSizeMb { get; init; }
    public int? SearchCacheTtlSeconds { get; init; }
    public int? SegmentCacheSizeMb { get; init; }
    public int? ConnectionBudget { get; init; }
    public bool? AddStreamarrBadge { get; init; }
    public bool? AddReleaseScoreToName { get; init; }
}
