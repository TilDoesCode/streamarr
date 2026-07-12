using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>
/// Machine API keys for headless clients (BRIEF §6.4 / §9.1). Tokens are stored only as
/// SHA-256 hashes; the plaintext is returned once at creation. A cached hash set feeds
/// the auth middleware without a DB round-trip per request. Singleton over
/// <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class ApiKeyService
{
    private readonly IDbContextFactory<StreamarrDbContext> _dbFactory;
    private readonly TimeProvider _time;
    private volatile HashSet<string> _activeHashes = new(StringComparer.Ordinal);

    public ApiKeyService(IDbContextFactory<StreamarrDbContext> dbFactory, TimeProvider time)
    {
        _dbFactory = dbFactory;
        _time = time;
        Reload();
    }

    /// <summary>True when the presented token matches an active (non-revoked) key.</summary>
    public bool IsValid(string presentedToken)
        => !string.IsNullOrEmpty(presentedToken) && _activeHashes.Contains(Hash(presentedToken));

    public void Reload()
    {
        using var db = _dbFactory.CreateDbContext();
        _activeHashes = db.ApiKeys.AsNoTracking()
            .Where(k => k.RevokedAt == null)
            .Select(k => k.KeyHash)
            .ToHashSet(StringComparer.Ordinal);
    }

    public async Task<IReadOnlyList<ApiKeyEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        // SQLite can't ORDER BY a DateTimeOffset column, so sort client-side.
        var keys = await db.ApiKeys.AsNoTracking().ToListAsync(ct);
        return keys.OrderByDescending(k => k.CreatedAt).ToList();
    }

    /// <summary>Mints a new key; returns the entity and the one-time plaintext token.</summary>
    public async Task<(ApiKeyEntity Entity, string Token)> CreateAsync(string name, CancellationToken ct)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var entity = new ApiKeyEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            Name = name,
            KeyHash = Hash(token),
            Prefix = token[..8],
            CreatedAt = _time.GetUtcNow(),
        };

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        db.ApiKeys.Add(entity);
        await db.SaveChangesAsync(ct);
        Reload();
        return (entity, token);
    }

    /// <summary>Revoke a key (soft delete); returns false when the id is unknown.</summary>
    public async Task<bool> RevokeAsync(string id, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.ApiKeys.FirstOrDefaultAsync(k => k.Id == id, ct);
        if (entity is null || entity.RevokedAt is not null)
            return false;

        entity.RevokedAt = _time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        Reload();
        return true;
    }

    internal static string Hash(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
}
