namespace Streamarr.Server.Tunnels;

/// <summary>A VPN provider preset: where to get a WireGuard <c>.conf</c>, sensible defaults, and how to check the exit IP.</summary>
public sealed record TunnelPreset
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>Where the user generates or downloads a WireGuard configuration for this provider.</summary>
    public required string HelpUrl { get; init; }

    /// <summary>DNS servers used inside the tunnel when the configuration names none.</summary>
    public required IReadOnlyList<string> DefaultDns { get; init; }

    public required int DefaultEndpointPort { get; init; }

    /// <summary>Provider endpoint returning JSON with the exit IP; null = the generic default.</summary>
    public string? ExitIpCheckUrl { get; init; }

    public required string Hint { get; init; }

    /// <summary>Endpoint host name fragments that identify this provider in an imported configuration.</summary>
    public IReadOnlyList<string> HostHints { get; init; } = [];
}

/// <summary>
/// Static catalog of supported providers (docs/vpn.md). Account APIs and server lists are deliberately out of scope:
/// every preset is configured by importing a WireGuard <c>.conf</c> the provider generated.
/// </summary>
public static class TunnelPresets
{
    public const string Custom = "custom";

    /// <summary>Generic exit-IP check used when a preset has no provider-specific one.</summary>
    public const string DefaultExitIpCheckUrl = "https://api.ipify.org?format=json";

    public static IReadOnlyList<TunnelPreset> All { get; } =
    [
        new()
        {
            Id = "mullvad",
            Name = "Mullvad VPN",
            HelpUrl = "https://mullvad.net/en/account/wireguard-config",
            DefaultDns = ["10.64.0.1"],
            DefaultEndpointPort = 51820,
            ExitIpCheckUrl = "https://am.i.mullvad.net/json",
            Hint = "Generate a WireGuard configuration in your Mullvad account (one key per device) and import the .conf file.",
            HostHints = ["mullvad.net", "relays.mullvad"],
        },
        new()
        {
            Id = "protonvpn",
            Name = "Proton VPN",
            HelpUrl = "https://account.protonvpn.com/downloads#wireguard-configuration",
            DefaultDns = ["10.2.0.1"],
            DefaultEndpointPort = 51820,
            Hint = "Create a WireGuard configuration under Downloads → WireGuard configuration in your Proton account and import it.",
            HostHints = ["protonvpn.net", "protonvpn.com"],
        },
        new()
        {
            Id = "nordvpn",
            Name = "NordVPN (NordLynx)",
            HelpUrl = "https://support.nordvpn.com/hc/en-us/articles/20196094470929",
            DefaultDns = ["103.86.96.100", "103.86.99.100"],
            DefaultEndpointPort = 51820,
            Hint = "NordVPN does not hand out .conf files; use your NordLynx private key and a server's public key from the NordVPN API or app to build one.",
            HostHints = ["nordvpn.com"],
        },
        new()
        {
            Id = "surfshark",
            Name = "Surfshark",
            HelpUrl = "https://my.surfshark.com/vpn/manual-setup/main/wireguard",
            DefaultDns = ["162.252.172.57", "149.154.159.92"],
            DefaultEndpointPort = 51820,
            Hint = "Generate a key pair under Manual setup → WireGuard in your Surfshark account, pick a location and import the .conf file.",
            HostHints = ["surfshark.com", "prod.surfshark"],
        },
        new()
        {
            Id = "pia",
            Name = "Private Internet Access",
            HelpUrl = "https://github.com/pia-foss/manual-connections",
            DefaultDns = ["10.0.0.243", "10.0.0.242"],
            DefaultEndpointPort = 1337,
            Hint = "PIA issues WireGuard keys through its manual-connections scripts; run them once and import the resulting .conf file.",
            HostHints = ["privateinternetaccess.com", "privacy.network"],
        },
        new()
        {
            Id = "airvpn",
            Name = "AirVPN",
            HelpUrl = "https://airvpn.org/generator/",
            DefaultDns = ["10.128.0.1"],
            DefaultEndpointPort = 1637,
            Hint = "Use the AirVPN config generator with WireGuard selected and import the .conf file.",
            HostHints = ["airvpn.org", "airdns.org", "vpn.airdns"],
        },
        new()
        {
            Id = "windscribe",
            Name = "Windscribe",
            HelpUrl = "https://windscribe.com/getconfig/wireguard",
            DefaultDns = ["10.255.255.1"],
            DefaultEndpointPort = 51820,
            Hint = "Create a WireGuard configuration under Config generators in your Windscribe account and import it.",
            HostHints = ["windscribe.com", "wgpeer"],
        },
        new()
        {
            Id = "ivpn",
            Name = "IVPN",
            HelpUrl = "https://www.ivpn.net/account/wireguard-config",
            DefaultDns = ["172.16.0.1"],
            DefaultEndpointPort = 2049,
            Hint = "Generate a WireGuard configuration in the IVPN account area and import the .conf file.",
            HostHints = ["ivpn.net", "wg.ivpn"],
        },
        new()
        {
            Id = Custom,
            Name = "Custom WireGuard",
            HelpUrl = "https://www.wireguard.com/quickstart/",
            DefaultDns = [],
            DefaultEndpointPort = 51820,
            Hint = "Any WireGuard peer: import the .conf file or enter the keys, endpoint and addresses by hand. DNS servers are required.",
        },
    ];

    public static TunnelPreset? Find(string? id)
        => string.IsNullOrWhiteSpace(id) ? null : All.FirstOrDefault(p => string.Equals(p.Id, id.Trim(), StringComparison.OrdinalIgnoreCase));

    public static bool IsKnown(string? id) => Find(id) is not null;

    /// <summary>
    /// Best-effort provider detection for an imported configuration: an endpoint host fragment or the provider's
    /// well-known in-tunnel DNS server. Falls back to <see cref="Custom"/>.
    /// </summary>
    public static string Detect(string? endpointHost, IReadOnlyList<string> dns)
    {
        if (!string.IsNullOrWhiteSpace(endpointHost))
        {
            foreach (var preset in All)
            {
                if (preset.HostHints.Any(h => endpointHost.Contains(h, StringComparison.OrdinalIgnoreCase)))
                    return preset.Id;
            }
        }

        foreach (var preset in All)
        {
            if (preset.DefaultDns.Count > 0 && dns.Any(d => preset.DefaultDns.Contains(d, StringComparer.OrdinalIgnoreCase)))
                return preset.Id;
        }

        return Custom;
    }
}
