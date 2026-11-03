using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Tunnels;

/// <summary>Validated and normalized tunnel settings ready to persist.</summary>
public sealed record NormalizedTunnel(
    string Name,
    string Preset,
    string Endpoint,
    IReadOnlyList<string> Addresses,
    IReadOnlyList<string> Dns,
    int? Mtu,
    int? Keepalive,
    string PeerPublicKey,
    IReadOnlyList<string> AllowedIps,
    string? PrivateKey,
    string? PresharedKey);

/// <summary>Field-level validation shared by the tunnels API and the <c>.conf</c> importer.</summary>
public static class TunnelValidation
{
    public static readonly IReadOnlyList<string> DefaultAllowedIps = ["0.0.0.0/0", "::/0"];
    public const int MinMtu = 1280;
    public const int MaxMtu = 1500;
    public const int MaxKeepalive = 600;
    public const int MaxAddresses = 8;
    public const int MaxDns = 8;
    public const int MaxAllowedIps = 32;

    /// <summary>
    /// Validates <paramref name="write"/>; <paramref name="requirePrivateKey"/> is true on create and on an update of a
    /// tunnel without a stored key. <paramref name="requireName"/> is false for import prefills.
    /// </summary>
    public static IReadOnlyList<TunnelFieldError> Validate(
        TunnelWrite write,
        bool requirePrivateKey,
        bool requireName,
        out NormalizedTunnel normalized)
    {
        var errors = new List<TunnelFieldError>();
        void Error(string field, string message) => errors.Add(new TunnelFieldError { Field = field, Message = message });

        var name = (write.Name ?? string.Empty).Trim();
        if (requireName && name.Length == 0)
            Error("name", "A non-empty name is required.");
        else if (name.Length > 128)
            Error("name", "The name must not exceed 128 characters.");
        else if (StreamarrOptionsValidator.ContainsControl(name))
            Error("name", "The name must not contain control characters.");

        var presetId = string.IsNullOrWhiteSpace(write.Preset) ? TunnelPresets.Custom : write.Preset.Trim().ToLowerInvariant();
        var preset = TunnelPresets.Find(presetId);
        if (preset is null)
        {
            Error("preset", $"Unknown preset '{write.Preset}'.");
            preset = TunnelPresets.Find(TunnelPresets.Custom)!;
        }

        string? privateKey = null;
        if (!string.IsNullOrEmpty(write.PrivateKey))
        {
            if (WireGuardKeys.TryParse(write.PrivateKey, out var key))
                privateKey = Convert.ToBase64String(key);
            else
                Error("privateKey", "The private key must be a base64-encoded 32-byte key.");
        }
        else if (requirePrivateKey)
        {
            Error("privateKey", "A private key is required.");
        }

        var peerKey = (write.PeerPublicKey ?? string.Empty).Trim();
        if (peerKey.Length == 0)
            Error("peerPublicKey", "The peer public key is required.");
        else if (WireGuardKeys.TryParse(peerKey, out var peer))
            peerKey = Convert.ToBase64String(peer);
        else
            Error("peerPublicKey", "The peer public key must be a base64-encoded 32-byte key.");

        string? presharedKey = null;
        if (!string.IsNullOrEmpty(write.PresharedKey))
        {
            if (WireGuardKeys.TryParse(write.PresharedKey, out var psk))
                presharedKey = Convert.ToBase64String(psk);
            else
                Error("presharedKey", "The preshared key must be a base64-encoded 32-byte key.");
        }

        var addresses = NormalizeCidrs(write.Addresses, "addresses", MaxAddresses, Error, hostOnly: true);
        if (addresses.Count == 0 && !errors.Any(e => e.Field == "addresses"))
            Error("addresses", "At least one interface address is required.");

        var dns = new List<string>();
        foreach (var raw in (write.Dns ?? []).Select(d => d?.Trim()).Where(d => !string.IsNullOrEmpty(d)))
        {
            if (dns.Count >= MaxDns)
            {
                Error("dns", $"At most {MaxDns} DNS servers are supported.");
                break;
            }
            if (TryParseIp(raw!, out var ip))
            {
                var text = ip.ToString();
                if (!dns.Contains(text, StringComparer.OrdinalIgnoreCase))
                    dns.Add(text);
            }
            else
            {
                Error("dns", $"'{raw}' is not an IP address.");
            }
        }
        if (dns.Count == 0 && !errors.Any(e => e.Field == "dns"))
        {
            dns.AddRange(preset.DefaultDns);
            if (dns.Count == 0)
                Error("dns", "At least one DNS server is required so hostnames resolve inside the tunnel.");
        }

        if (write.Mtu is { } mtu && (mtu < MinMtu || mtu > MaxMtu))
            Error("mtu", $"The MTU must be between {MinMtu} and {MaxMtu}.");
        if (write.Keepalive is { } keepalive && (keepalive < 0 || keepalive > MaxKeepalive))
            Error("keepalive", $"The keepalive must be between 0 and {MaxKeepalive} seconds.");

        var endpoint = string.Empty;
        if (string.IsNullOrWhiteSpace(write.Endpoint))
            Error("endpoint", "The endpoint is required.");
        else if (TryNormalizeEndpoint(write.Endpoint, preset.DefaultEndpointPort, out endpoint, out _, out _) is { } problem)
            Error("endpoint", problem);

        var allowedIps = NormalizeCidrs(write.AllowedIps, "allowedIps", MaxAllowedIps, Error, hostOnly: false);
        if (allowedIps.Count == 0 && !errors.Any(e => e.Field == "allowedIps"))
            allowedIps = DefaultAllowedIps.ToList();

        normalized = new NormalizedTunnel(
            name,
            preset.Id,
            endpoint,
            addresses,
            dns,
            write.Mtu,
            write.Keepalive is > 0 ? write.Keepalive : null,
            peerKey,
            allowedIps,
            privateKey,
            presharedKey);
        return errors;
    }

    private static List<string> NormalizeCidrs(IReadOnlyList<string>? values, string field, int max, Action<string, string> error, bool hostOnly)
    {
        var result = new List<string>();
        foreach (var raw in (values ?? []).Select(v => v?.Trim()).Where(v => !string.IsNullOrEmpty(v)))
        {
            if (result.Count >= max)
            {
                error(field, $"At most {max} entries are supported.");
                break;
            }
            if (TryNormalizeCidr(raw!, hostOnly, out var cidr))
            {
                if (!result.Contains(cidr, StringComparer.OrdinalIgnoreCase))
                    result.Add(cidr);
            }
            else
            {
                error(field, hostOnly ? $"'{raw}' is not an IP address or CIDR." : $"'{raw}' is not a CIDR network.");
            }
        }
        return result;
    }

    /// <summary>Accepts <c>ip</c> or <c>ip/prefix</c>; a bare IP gets /32 (IPv4) or /128 (IPv6).</summary>
    public static bool TryNormalizeCidr(string value, bool hostOnly, out string normalized)
    {
        normalized = string.Empty;
        var slash = value.IndexOf('/');
        var ipText = slash < 0 ? value : value[..slash];
        if (!TryParseIp(ipText.Trim(), out var ip))
            return false;
        var bits = ip.AddressFamily == AddressFamily.InterNetwork ? 32 : 128;
        var prefix = bits;
        if (slash >= 0 && (!int.TryParse(value[(slash + 1)..].Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out prefix) || prefix < 0 || prefix > bits))
            return false;
        normalized = $"{ip}/{prefix}";
        return true;
    }

    /// <summary>Parses <c>host:port</c> or <c>[v6]:port</c>; a missing port takes <paramref name="defaultPort"/>. Returns a problem text or null.</summary>
    public static string? TryNormalizeEndpoint(string value, int defaultPort, out string normalized, out string host, out int port)
    {
        normalized = string.Empty;
        host = string.Empty;
        port = defaultPort;
        var text = value.Trim();
        if (text.Length == 0 || text.Length > 300 || StreamarrOptionsValidator.ContainsControl(text) || text.Any(char.IsWhiteSpace))
            return "The endpoint must be host:port.";

        string hostPart;
        string? portPart = null;
        if (text.StartsWith('['))
        {
            var close = text.IndexOf(']');
            if (close < 0)
                return "The IPv6 endpoint must be written as [address]:port.";
            hostPart = text[1..close];
            var rest = text[(close + 1)..];
            if (rest.Length > 0)
            {
                if (!rest.StartsWith(':'))
                    return "The IPv6 endpoint must be written as [address]:port.";
                portPart = rest[1..];
            }
        }
        else
        {
            var colon = text.LastIndexOf(':');
            if (colon >= 0 && text.IndexOf(':') != colon)
                return "The IPv6 endpoint must be written as [address]:port.";
            hostPart = colon < 0 ? text : text[..colon];
            portPart = colon < 0 ? null : text[(colon + 1)..];
        }

        if (portPart is not null && (!int.TryParse(portPart, NumberStyles.None, CultureInfo.InvariantCulture, out port) || port is < 1 or > 65535))
            return "The endpoint port must be between 1 and 65535.";

        var kind = Uri.CheckHostName(hostPart);
        if (hostPart.Length == 0 || hostPart.Length > 253 || kind == UriHostNameType.Unknown || kind == UriHostNameType.Basic)
            return "The endpoint host must be a hostname or IP address.";

        host = kind == UriHostNameType.IPv6 ? IPAddress.Parse(hostPart).ToString() : hostPart.ToLowerInvariant();
        normalized = kind == UriHostNameType.IPv6 ? $"[{host}]:{port}" : $"{host}:{port}";
        return null;
    }

    private static bool TryParseIp(string text, out IPAddress ip)
    {
        ip = IPAddress.None;
        if (string.IsNullOrEmpty(text) || text.Contains('%'))
            return false;
        if (!IPAddress.TryParse(text, out var parsed))
            return false;
        if (parsed.AddressFamily is not (AddressFamily.InterNetwork or AddressFamily.InterNetworkV6))
            return false;
        // IPAddress.TryParse accepts shorthand like "10.1"; require dotted quad for IPv4.
        if (parsed.AddressFamily == AddressFamily.InterNetwork && text.Count(c => c == '.') != 3)
            return false;
        ip = parsed;
        return true;
    }
}
