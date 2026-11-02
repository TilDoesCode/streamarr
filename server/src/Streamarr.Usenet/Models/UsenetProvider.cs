namespace Streamarr.Usenet.Models;

/// <summary>
/// How a provider participates in the multi-provider pool.
/// Ported from nzbdav backend/Models/ProviderType.cs (MIT, see NOTICE).
/// </summary>
public enum UsenetProviderType
{
    Disabled = 0,
    Pooled = 1,
    BackupOnly = 2,
}

/// <summary>
/// Connection details for one Usenet provider. The NNTP pool is built against a
/// priority-ordered list of these from the start (DECISIONS.md #6).
/// </summary>
public sealed record UsenetProvider
{
    public required string Name { get; init; }
    public required string Host { get; init; }
    public required int Port { get; init; }
    public required bool UseSsl { get; init; }
    public string Username { get; init; } = string.Empty;
    public string Password { get; init; } = string.Empty;
    public int MaxConnections { get; init; } = 10;
    /// <summary>Lower value = preferred. Used to order providers ahead of type/availability.</summary>
    public int Priority { get; init; }
    public UsenetProviderType Type { get; init; } = UsenetProviderType.Pooled;

    /// <summary>Streamarr tunnel id this provider is routed through; null = direct. Informational, see <see cref="Route"/>.</summary>
    public string? TunnelId { get; init; }

    /// <summary>How new connections leave the host (direct or through a tunnel's SOCKS5 proxy); never null.</summary>
    public NntpConnectionRoute Route { get; init; } = NntpConnectionRoute.Direct;
}
