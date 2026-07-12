using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Profiles;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>
/// SQLite-backed quality profile store (BRIEF §7.3). Implements the synchronous
/// <see cref="IProfileProvider"/> for the ranker from a cached snapshot; the built-in
/// <see cref="DefaultProfiles.Standard"/> is always available and is the fallback for an
/// unknown/absent profile id. A singleton over <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class ProfileConfigService : IProfileProvider
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly IDbContextFactory<StreamarrDbContext> _dbFactory;
    private volatile IReadOnlyDictionary<string, QualityProfile> _cache =
        new Dictionary<string, QualityProfile>(StringComparer.Ordinal);

    public ProfileConfigService(IDbContextFactory<StreamarrDbContext> dbFactory)
    {
        _dbFactory = dbFactory;
        Reload();
    }

    // ---- IProfileProvider (ranker path) ----------------------------------------------

    public QualityProfile Get(string? profileId)
    {
        if (string.IsNullOrWhiteSpace(profileId) || profileId == DefaultProfiles.Standard.Id)
            return DefaultProfiles.Standard;

        return _cache.TryGetValue(profileId, out var profile) ? profile : DefaultProfiles.Standard;
    }

    public void Reload()
    {
        using var db = _dbFactory.CreateDbContext();
        var rows = db.Profiles.AsNoTracking().ToList();
        var map = new Dictionary<string, QualityProfile>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var profile = Deserialize(row);
            if (profile is not null)
                map[row.Id] = profile;
        }

        _cache = map;
    }

    // ---- CRUD (config API) -----------------------------------------------------------

    /// <summary>All profiles: the built-in default plus every stored profile.</summary>
    public IReadOnlyList<QualityProfile> List()
        => new[] { DefaultProfiles.Standard }.Concat(_cache.Values.OrderBy(p => p.Name)).ToArray();

    /// <summary>Look up a profile by id (incl. the built-in default); null if unknown.</summary>
    public QualityProfile? FindById(string id)
    {
        if (id == DefaultProfiles.Standard.Id)
            return DefaultProfiles.Standard;
        return _cache.GetValueOrDefault(id);
    }

    public async Task<QualityProfile> CreateAsync(QualityProfile profile, CancellationToken ct)
    {
        var id = string.IsNullOrWhiteSpace(profile.Id) ? Guid.NewGuid().ToString("n") : profile.Id;
        var stored = profile with { Id = id, IsDefault = false };

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        db.Profiles.Add(new ProfileEntity { Id = id, Name = stored.Name, PayloadJson = Serialize(stored) });
        await db.SaveChangesAsync(ct);
        Reload();
        return stored;
    }

    public async Task<QualityProfile?> UpdateAsync(string id, QualityProfile profile, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Profiles.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (entity is null)
            return null;

        var stored = profile with { Id = id, IsDefault = false };
        entity.Name = stored.Name;
        entity.PayloadJson = Serialize(stored);
        await db.SaveChangesAsync(ct);
        Reload();
        return stored;
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Profiles.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (entity is null)
            return false;

        db.Profiles.Remove(entity);
        await db.SaveChangesAsync(ct);
        Reload();
        return true;
    }

    internal static string Serialize(QualityProfile profile) => JsonSerializer.Serialize(profile, Json);

    private static QualityProfile? Deserialize(ProfileEntity row)
    {
        try
        {
            var profile = JsonSerializer.Deserialize<QualityProfile>(row.PayloadJson, Json);
            if (profile is null)
                return null;

            // Preserve the case-insensitive size-band lookup the defaults ship with.
            return profile with
            {
                SizeBands = new Dictionary<string, SizeBand>(profile.SizeBands, StringComparer.OrdinalIgnoreCase),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
