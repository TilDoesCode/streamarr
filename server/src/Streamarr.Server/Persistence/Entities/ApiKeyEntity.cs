namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// A machine API key for headless clients (BRIEF §6.4 / §9.1). Only a SHA-256 hash of
/// the key is stored — the plaintext is shown once at creation and never again.
/// </summary>
public sealed class ApiKeyEntity
{
    public required string Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>Lower-hex SHA-256 of the token; the token itself is never persisted.</summary>
    public string KeyHash { get; set; } = string.Empty;

    /// <summary>First few characters of the token, for identification in the UI.</summary>
    public string Prefix { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}
