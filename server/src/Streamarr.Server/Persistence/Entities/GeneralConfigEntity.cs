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

    public int SessionTtlSeconds { get; set; } = 3600;

    public int SearchCacheTtlSeconds { get; set; } = 60;

    /// <summary>Segment cache size in mebibytes.</summary>
    public int SegmentCacheSizeMb { get; set; } = 512;

    public int ConnectionBudget { get; set; } = 20;
}
