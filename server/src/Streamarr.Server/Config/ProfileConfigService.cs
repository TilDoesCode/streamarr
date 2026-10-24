using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Profiles;
using Streamarr.Core.Media;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>The server-wide ranking profile defaults: one for everything, optional ones per media type, and whether viewers may choose their own.</summary>
public sealed record ProfileDefaults(string? DefaultProfileId, string? MovieProfileId, string? SeriesProfileId, bool ViewersMayChoose)
{
    public static ProfileDefaults Initial { get; } = new(null, null, null, true);
}

/// <summary>
/// SQLite-backed quality profile store (BRIEF §7.3). Implements the synchronous
/// <see cref="IProfileProvider"/> for the ranker from a cached snapshot; the built-in
/// <see cref="DefaultProfiles.Standard"/> is always available. An absent, unknown or
/// media-type-mismatched profile id falls back to the server default for the media type,
/// and that to Standard. A singleton over <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class ProfileConfigService : IProfileProvider
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly IDbContextFactory<StreamarrDbContext> _dbFactory;
    private volatile IReadOnlyDictionary<string, QualityProfile> _cache =
        new Dictionary<string, QualityProfile>(StringComparer.Ordinal);
    private volatile ProfileDefaults _defaults = ProfileDefaults.Initial;
    private long _revision;

    public ProfileConfigService(IDbContextFactory<StreamarrDbContext> dbFactory)
    {
        _dbFactory = dbFactory;
        Reload();
    }

    // ---- IProfileProvider (ranker path) ----------------------------------------------

    public QualityProfile Get(string? profileId, MediaType? mediaType = null)
        => Usable(profileId, mediaType) ?? ServerDefault(mediaType);

    /// <summary>The server default for <paramref name="mediaType"/>: its own override, else the general default, else Standard (each only when it exists and applies).</summary>
    public QualityProfile ServerDefault(MediaType? mediaType)
    {
        var defaults = _defaults;
        var specific = mediaType switch
        {
            MediaType.Movie => defaults.MovieProfileId,
            MediaType.Tv => defaults.SeriesProfileId,
            _ => null,
        };
        return Usable(specific, mediaType) ?? Usable(defaults.DefaultProfileId, mediaType) ?? DefaultProfiles.Standard;
    }

    /// <summary>The profile with <paramref name="profileId"/> when it exists and applies to <paramref name="mediaType"/>; else null.</summary>
    public QualityProfile? Usable(string? profileId, MediaType? mediaType)
    {
        if (string.IsNullOrWhiteSpace(profileId))
            return null;
        if (profileId == DefaultProfiles.Standard.Id)
            return DefaultProfiles.Standard;
        return _cache.TryGetValue(profileId, out var profile) && profile.AppliesToMediaType(mediaType) ? profile : null;
    }

    public ProfileDefaults Defaults => _defaults;

    /// <summary>Bumped on every change of a profile or of the defaults; rankings cached under an older revision are stale.</summary>
    public long Revision => Interlocked.Read(ref _revision);

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

        var general = db.GeneralConfig.AsNoTracking().SingleOrDefault(g => g.Id == 1);
        _cache = map;
        _defaults = general is null
            ? ProfileDefaults.Initial
            : new ProfileDefaults(general.DefaultProfileId, general.MovieProfileId, general.SeriesProfileId, general.ViewersMayChooseProfile);
        Interlocked.Increment(ref _revision);
    }

    /// <summary>Validates and stores the defaults; returns an error code and message, or null on success.</summary>
    public async Task<(string Code, string Message)?> UpdateDefaultsAsync(ProfileDefaults write, CancellationToken ct)
    {
        if (write.DefaultProfileId is { } general && FindById(general) is null)
            return ("unknown_profile", $"No profile with id '{general}'.");
        foreach (var (id, type, label) in new[] { (write.MovieProfileId, MediaType.Movie, "movies"), (write.SeriesProfileId, MediaType.Tv, "series") })
        {
            if (id is null)
                continue;
            if (FindById(id) is not { } profile)
                return ("unknown_profile", $"No profile with id '{id}'.");
            if (!profile.AppliesToMediaType(type))
                return ("profile_media_type_mismatch", $"The profile '{profile.Name}' does not apply to {label}.");
        }

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.GeneralConfig.SingleOrDefaultAsync(g => g.Id == 1, ct);
        if (entity is null)
        {
            entity = new GeneralConfigEntity { Id = 1 };
            db.GeneralConfig.Add(entity);
        }
        entity.DefaultProfileId = write.DefaultProfileId == DefaultProfiles.Standard.Id ? null : write.DefaultProfileId;
        entity.MovieProfileId = write.MovieProfileId;
        entity.SeriesProfileId = write.SeriesProfileId;
        entity.ViewersMayChooseProfile = write.ViewersMayChoose;
        await db.SaveChangesAsync(ct);
        Reload();
        return null;
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

    public async Task<IReadOnlyList<QualityProfile>> CreateManyAsync(
        IReadOnlyList<QualityProfile> profiles,
        CancellationToken ct)
    {
        var stored = profiles.Select(profile => profile with
        {
            Id = Guid.NewGuid().ToString("n"),
            IsDefault = false,
        }).ToArray();

        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        db.Profiles.AddRange(stored.Select(profile => new ProfileEntity
        {
            Id = profile.Id,
            Name = profile.Name,
            PayloadJson = Serialize(profile),
        }));
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
        // No dangling ids: the defaults and every viewer that used the profile fall back to the next step.
        if (await db.GeneralConfig.SingleOrDefaultAsync(g => g.Id == 1, ct) is { } general)
        {
            if (general.DefaultProfileId == id) general.DefaultProfileId = null;
            if (general.MovieProfileId == id) general.MovieProfileId = null;
            if (general.SeriesProfileId == id) general.SeriesProfileId = null;
        }
        foreach (var viewer in await db.Viewers.Where(v => v.RankingProfileId == id).ToListAsync(ct))
            viewer.RankingProfileId = null;
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
            if (profile is null ||
                profile.PreferredResolutions is null ||
                profile.PreferredSources is null ||
                profile.PreferredCodecs is null ||
                profile.PreferredLanguages is null ||
                profile.GroupAllowList is null ||
                profile.GroupDenyList is null ||
                profile.SizeBands is null)
                return null;

            if (profile.CustomFormats is null || profile.CustomFormats.Any(format => format?.Conditions is null))
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
