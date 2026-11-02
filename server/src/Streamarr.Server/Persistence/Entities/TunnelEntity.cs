namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Persisted WireGuard tunnel (docs/vpn.md). The private and preshared keys are stored only as
/// Data-Protection ciphertext; the config API never returns them, only the derived public key.
/// Providers and indexers reference a tunnel through their <c>TunnelId</c> column.
/// </summary>
public sealed class TunnelEntity
{
    public required string Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>Preset id from the static catalog (<c>mullvad</c>, <c>protonvpn</c>, …, <c>custom</c>).</summary>
    public string Preset { get; set; } = "custom";

    public bool Enabled { get; set; } = true;

    /// <summary>Peer endpoint as <c>host:port</c>.</summary>
    public string Endpoint { get; set; } = string.Empty;

    /// <summary>Comma-separated interface addresses in CIDR notation.</summary>
    public string Addresses { get; set; } = string.Empty;

    /// <summary>Comma-separated DNS server IPs used inside the tunnel.</summary>
    public string Dns { get; set; } = string.Empty;

    public int? Mtu { get; set; }

    /// <summary>PersistentKeepalive in seconds; null = off.</summary>
    public int? Keepalive { get; set; }

    /// <summary>The peer's Curve25519 public key, base64.</summary>
    public string PeerPublicKey { get; set; } = string.Empty;

    /// <summary>Data-Protection ciphertext of the interface private key (secret, at rest).</summary>
    public string? PrivateKeyEncrypted { get; set; }

    /// <summary>Data-Protection ciphertext of the optional preshared key (secret, at rest).</summary>
    public string? PresharedKeyEncrypted { get; set; }

    /// <summary>Comma-separated AllowedIPs CIDRs for the peer.</summary>
    public string AllowedIps { get; set; } = string.Empty;

    /// <summary>Fixed loopback port of this tunnel's SOCKS5 proxy, assigned once at creation.</summary>
    public int LocalPort { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
