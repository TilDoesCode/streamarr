namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Persisted general configuration (BRIEF §6.3): a single row (<see cref="Id"/> = 1).
/// TMDB key, TTLs, cache sizes and the global NNTP connection budget. The TMDB key is
/// Data-Protection ciphertext.
/// </summary>
public sealed class GeneralConfigEntity
{
    /// <summary>Fixed singleton primary key.</summary>
    public int Id { get; set; } = 1;

    /// <summary>Data-Protection ciphertext of the TMDB API key (secret, at rest).</summary>
    public string? TmdbApiKeyEncrypted { get; set; }

    /// <summary>
    /// Data-Protection ciphertext of the HMAC key that signs admin session JWTs (BRIEF
    /// §6.4). Generated once on first run so tokens survive restarts; never exposed by the
    /// config API.
    /// </summary>
    public string? JwtSigningKeyEncrypted { get; set; }

    public int SessionTtlSeconds { get; set; } = 86_400;

    /// <summary>Logical ephemeral-file cache size in mebibytes.</summary>
    public int EphemeralCacheSizeMb { get; set; } = 102_400;

    public int SearchCacheTtlSeconds { get; set; } = 60;

    /// <summary>Segment cache size in mebibytes.</summary>
    public int SegmentCacheSizeMb { get; set; } = 512;

    public int ConnectionBudget { get; set; } = 20;

    /// <summary>Whether work posters should carry the adaptive Streamarr source badge.</summary>
    public bool AddStreamarrBadge { get; set; } = true;

    /// <summary>Whether Jellyfin version names should include the Core ranking score.</summary>
    public bool AddReleaseScoreToName { get; set; } = true;
}
