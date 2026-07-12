namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Persisted Usenet provider config (BRIEF §6.3, DECISIONS.md #6 — multiple,
/// priority-ordered). <see cref="PasswordEncrypted"/> is Data-Protection ciphertext.
/// </summary>
public sealed class ProviderEntity
{
    public required string Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 563;
    public bool UseSsl { get; set; } = true;
    public string Username { get; set; } = string.Empty;

    /// <summary>Data-Protection ciphertext of the provider password (secret, at rest).</summary>
    public string? PasswordEncrypted { get; set; }

    public int MaxConnections { get; set; } = 10;
    public int Priority { get; set; }
    public bool Enabled { get; set; } = true;

    /// <summary>True for block/backup accounts that only backfill misses (M7 failover).</summary>
    public bool IsBackupOnly { get; set; }
}
