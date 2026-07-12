namespace Streamarr.Core.Providers;

/// <summary>
/// Configuration of one Usenet provider. Multiple priority-ordered providers are
/// supported from the start (DECISIONS.md #6): schema and config API carry a list;
/// actual failover logic is layered on in M7.
/// </summary>
public sealed record UsenetProviderConfig
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Host { get; init; }
    public int Port { get; init; } = 563;
    public bool UseSsl { get; init; } = true;
    public string Username { get; init; } = string.Empty;

    /// <summary>Secret: encrypted at rest, never returned in plaintext by the config API.</summary>
    public string Password { get; init; } = string.Empty;

    public int MaxConnections { get; init; } = 10;

    /// <summary>Lower value = preferred (primary = 0, block account fallback &gt; 0).</summary>
    public int Priority { get; init; }

    public bool Enabled { get; init; } = true;

    /// <summary>True for block/backup accounts that should only backfill misses.</summary>
    public bool IsBackupOnly { get; init; }
}
