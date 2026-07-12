namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Persisted Newznab indexer config (BRIEF §6.3). <see cref="ApiKeyEncrypted"/> holds
/// the ciphertext produced by ASP.NET Data Protection — the plaintext key never
/// touches the database and is never returned by the config API.
/// </summary>
public sealed class IndexerEntity
{
    public required string Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>Data-Protection ciphertext of the indexer API key (secret, at rest).</summary>
    public string? ApiKeyEncrypted { get; set; }

    /// <summary>Comma-separated Newznab category ids (e.g. "2000,5000").</summary>
    public string Categories { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;
    public int Priority { get; set; }
}
