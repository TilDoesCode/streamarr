namespace Streamarr.Server.Contracts;

// ---- Tunnels (docs/vpn.md) ----------------------------------------------------------

/// <summary>A WireGuard tunnel as returned by the tunnels API. The private and preshared keys never cross the wire.</summary>
public sealed record TunnelResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>Preset id: <c>mullvad</c>, <c>protonvpn</c>, <c>nordvpn</c>, <c>surfshark</c>, <c>pia</c>, <c>airvpn</c>, <c>windscribe</c>, <c>ivpn</c> or <c>custom</c>.</summary>
    public required string Preset { get; init; }

    public required bool Enabled { get; init; }

    /// <summary>Peer endpoint as <c>host:port</c> (IPv6 hosts in brackets).</summary>
    public required string Endpoint { get; init; }

    /// <summary>Interface addresses in CIDR notation.</summary>
    public required IReadOnlyList<string> Addresses { get; init; }

    /// <summary>DNS servers used inside the tunnel (hostnames of routed connections are resolved through them, never on the host).</summary>
    public required IReadOnlyList<string> Dns { get; init; }

    public int? Mtu { get; init; }

    /// <summary>PersistentKeepalive in seconds; null = off.</summary>
    public int? Keepalive { get; init; }

    /// <summary>The VPN server's public key (base64).</summary>
    public required string PeerPublicKey { get; init; }

    public required bool HasPrivateKey { get; init; }

    /// <summary>Public key derived from the stored private key, i.e. what the provider knows this device as; null without a private key.</summary>
    public string? PublicKey { get; init; }

    public required bool HasPresharedKey { get; init; }

    /// <summary>AllowedIPs of the peer; normally <c>0.0.0.0/0</c> and <c>::/0</c>.</summary>
    public required IReadOnlyList<string> AllowedIps { get; init; }

    public required TunnelStatus Status { get; init; }

    /// <summary>Providers and indexers routed through this tunnel.</summary>
    public required TunnelUsage UsedBy { get; init; }
}

/// <summary>Live state of a tunnel as reported by its helper process.</summary>
public sealed record TunnelStatus
{
    /// <summary><c>disabled</c>, <c>starting</c>, <c>connected</c>, <c>degraded</c> or <c>down</c>. Only <c>connected</c> lets routed traffic through.</summary>
    public required string State { get; init; }

    /// <summary>When the tunnel entered its current state.</summary>
    public required DateTimeOffset Since { get; init; }

    public DateTimeOffset? LastHandshakeUtc { get; init; }

    /// <summary>Public IP seen through the tunnel by the last check.</summary>
    public string? ExitIp { get; init; }

    /// <summary>Round trip of the last exit check through the tunnel.</summary>
    public double? LatencyMs { get; init; }

    public long? RxBytes { get; init; }
    public long? TxBytes { get; init; }

    /// <summary>Why the tunnel is not connected, when it is not.</summary>
    public string? LastError { get; init; }
}

public sealed record TunnelUsage
{
    public required IReadOnlyList<TunnelUsageRef> Providers { get; init; }
    public required IReadOnlyList<TunnelUsageRef> Indexers { get; init; }

    public bool Any => Providers.Count > 0 || Indexers.Count > 0;

    public static TunnelUsage Empty { get; } = new() { Providers = [], Indexers = [] };
}

public sealed record TunnelUsageRef
{
    public required string Id { get; init; }
    public required string Name { get; init; }
}

/// <summary>
/// Write model for tunnel create/update. <c>privateKey</c> and <c>presharedKey</c> are write-only: omitted on update
/// keeps the stored value; <c>presharedKey: ""</c> removes the preshared key.
/// </summary>
public sealed record TunnelWrite
{
    public required string Name { get; init; }

    /// <summary>Preset id; omitted = <c>custom</c>.</summary>
    public string? Preset { get; init; }

    /// <summary>Omitted = enabled on create, unchanged on update.</summary>
    public bool? Enabled { get; init; }

    /// <summary>Base64 Curve25519 private key. Required on create; omit on update to keep the stored key.</summary>
    public string? PrivateKey { get; init; }

    /// <summary>Interface addresses (CIDR or bare IP); at least one.</summary>
    public IReadOnlyList<string>? Addresses { get; init; }

    /// <summary>DNS server IPs used inside the tunnel; omitted or empty = the preset's defaults (custom needs at least one).</summary>
    public IReadOnlyList<string>? Dns { get; init; }

    /// <summary>1280–1500; omitted = WireGuard default.</summary>
    public int? Mtu { get; init; }

    /// <summary>PersistentKeepalive seconds (0–600); omitted or 0 = off.</summary>
    public int? Keepalive { get; init; }

    /// <summary>Base64 public key of the VPN server.</summary>
    public required string PeerPublicKey { get; init; }

    /// <summary>Base64 preshared key; omit to keep, empty string to remove.</summary>
    public string? PresharedKey { get; init; }

    /// <summary><c>host:port</c> of the VPN server.</summary>
    public required string Endpoint { get; init; }

    /// <summary>AllowedIPs CIDRs; omitted or empty = <c>0.0.0.0/0</c> and <c>::/0</c>.</summary>
    public IReadOnlyList<string>? AllowedIps { get; init; }
}

/// <summary>Outcome of POST /api/v1/tunnels/{id}/test: a live handshake and exit-IP check through the tunnel.</summary>
public sealed record TunnelTestResult
{
    /// <summary>True when the handshake is fresh and the exit check answered.</summary>
    public required bool Success { get; init; }

    public required bool HandshakeOk { get; init; }

    /// <summary>Tunnel state after the test: <c>disabled</c>, <c>starting</c>, <c>connected</c>, <c>degraded</c> or <c>down</c>.</summary>
    public required string State { get; init; }

    public string? ExitIp { get; init; }
    public double? LatencyMs { get; init; }
    public DateTimeOffset? LastHandshakeUtc { get; init; }
    public string? Error { get; init; }
}

/// <summary>POST /api/v1/tunnels/import body: the text of a WireGuard <c>.conf</c> file.</summary>
public sealed record TunnelImportRequest
{
    public required string Text { get; init; }
}

/// <summary>
/// Parsed <c>.conf</c> as a prefilled tunnel write model plus per-field problems. Nothing is stored; the prefill
/// echoes the secrets the caller just posted so the form can submit them to POST /api/v1/tunnels.
/// </summary>
public sealed record TunnelImportResponse
{
    /// <summary>True when <c>errors</c> is empty and the prefill can be saved as is (after naming it).</summary>
    public required bool Valid { get; init; }

    public required TunnelWrite Tunnel { get; init; }

    /// <summary>Preset recognised from the endpoint or DNS servers; <c>custom</c> when unknown.</summary>
    public required string DetectedPreset { get; init; }

    public required IReadOnlyList<TunnelFieldError> Errors { get; init; }

    /// <summary>Ignored or unusual settings worth a glance (e.g. a second peer, PostUp scripts, DNS search domains).</summary>
    public required IReadOnlyList<string> Warnings { get; init; }
}

/// <summary>One validation problem, keyed by the camelCase tunnel field (or <c>interface</c>/<c>peer</c>/<c>text</c> for structural problems).</summary>
public sealed record TunnelFieldError
{
    public required string Field { get; init; }
    public required string Message { get; init; }
}

/// <summary>A supported VPN provider preset (GET /api/v1/tunnels/presets).</summary>
public sealed record TunnelPresetResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>Where the user generates or downloads a WireGuard configuration.</summary>
    public required string HelpUrl { get; init; }

    public required IReadOnlyList<string> DefaultDns { get; init; }
    public required int DefaultEndpointPort { get; init; }

    /// <summary>Provider endpoint used to verify the exit IP; null = generic check.</summary>
    public string? ExitIpCheckUrl { get; init; }

    public required string Hint { get; init; }
}

/// <summary>Lightweight state of every tunnel for polling (GET /api/v1/tunnels/status).</summary>
public sealed record TunnelStatusListResponse
{
    public required IReadOnlyList<TunnelStatusEntry> Tunnels { get; init; }
    public required DateTimeOffset CheckedAt { get; init; }
}

public sealed record TunnelStatusEntry
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required TunnelStatus Status { get; init; }
}

/// <summary>How a provider's or indexer's connections leave the server (read-only, derived from <c>tunnelId</c> and live tunnel state).</summary>
public sealed record RouteInfo
{
    /// <summary><c>direct</c>, <c>tunnel</c> or <c>externalProxy</c> (the legacy INDEXER_PROXY, indexers only).</summary>
    public required string Kind { get; init; }

    public string? TunnelId { get; init; }
    public string? TunnelName { get; init; }

    /// <summary>The tunnel's state for <c>tunnel</c> routes: <c>disabled</c>, <c>starting</c>, <c>connected</c>, <c>degraded</c> or <c>down</c>.</summary>
    public string? State { get; init; }

    /// <summary>False when connections over this route fail immediately ("VPN down"); direct and external-proxy routes are always usable.</summary>
    public required bool Usable { get; init; }

    /// <summary>Why the tunnel is not usable, when it is not (the tunnel status's <c>lastError</c>).</summary>
    public string? LastError { get; init; }

    public const string Direct = "direct";
    public const string Tunnel = "tunnel";
    public const string ExternalProxy = "externalProxy";
}
