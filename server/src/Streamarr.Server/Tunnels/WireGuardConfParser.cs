using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// Turns the text of a WireGuard <c>.conf</c> (<c>[Interface]</c> + one <c>[Peer]</c>) into a prefilled
/// <see cref="TunnelWrite"/> with per-field validation errors, for POST /api/v1/tunnels/import.
/// </summary>
public static class WireGuardConfParser
{
    public const int MaxTextLength = 64 * 1024;

    private static readonly HashSet<string> IgnoredInterfaceKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "ListenPort", "Table", "FwMark", "SaveConfig", "PreUp", "PostUp", "PreDown", "PostDown",
    };

    public static TunnelImportResponse Parse(string? text)
    {
        var errors = new List<TunnelFieldError>();
        var warnings = new List<string>();
        void Error(string field, string message) => errors.Add(new TunnelFieldError { Field = field, Message = message });

        if (string.IsNullOrWhiteSpace(text))
        {
            Error("text", "The configuration text is empty.");
            return Result(Empty(), errors, warnings, TunnelPresets.Custom);
        }
        if (text.Length > MaxTextLength)
        {
            Error("text", $"The configuration must not exceed {MaxTextLength / 1024} KiB.");
            return Result(Empty(), errors, warnings, TunnelPresets.Custom);
        }

        string? section = null;
        var sawInterface = false;
        var peers = 0;
        string? privateKey = null, publicKey = null, presharedKey = null, endpoint = null, mtu = null, keepalive = null;
        var addresses = new List<string>();
        var dns = new List<string>();
        var allowedIps = new List<string>();

        foreach (var rawLine in text.TrimStart('\uFEFF').Split('\n'))
        {
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0)
                continue;

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                section = line[1..^1].Trim().ToLowerInvariant();
                switch (section)
                {
                    case "interface":
                        if (sawInterface)
                            Error("interface", "More than one [Interface] section.");
                        sawInterface = true;
                        break;
                    case "peer":
                        peers++;
                        if (peers > 1)
                            Error("peer", "Only one [Peer] section is supported; the first one is used.");
                        break;
                    default:
                        warnings.Add($"Unknown section [{section}] ignored.");
                        break;
                }
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                warnings.Add($"Ignored line without '=': {Truncate(line)}");
                continue;
            }
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();

            if (section == "interface")
            {
                switch (key.ToLowerInvariant())
                {
                    case "privatekey":
                        privateKey = value;
                        break;
                    case "address":
                        addresses.AddRange(SplitList(value));
                        break;
                    case "dns":
                        foreach (var entry in SplitList(value))
                        {
                            if (System.Net.IPAddress.TryParse(entry, out _))
                                dns.Add(entry);
                            else
                                warnings.Add($"DNS search domain '{entry}' ignored (only server IPs are used).");
                        }
                        break;
                    case "mtu":
                        mtu = value;
                        break;
                    default:
                        if (IgnoredInterfaceKeys.Contains(key))
                            warnings.Add($"{key} ignored: the userspace tunnel has no network interface or scripts.");
                        else
                            warnings.Add($"Unknown [Interface] setting '{key}' ignored.");
                        break;
                }
            }
            else if (section == "peer" && peers == 1)
            {
                switch (key.ToLowerInvariant())
                {
                    case "publickey":
                        publicKey = value;
                        break;
                    case "presharedkey":
                        presharedKey = value;
                        break;
                    case "allowedips":
                        allowedIps.AddRange(SplitList(value));
                        break;
                    case "endpoint":
                        endpoint = value;
                        break;
                    case "persistentkeepalive":
                        keepalive = value;
                        break;
                    default:
                        warnings.Add($"Unknown [Peer] setting '{key}' ignored.");
                        break;
                }
            }
            else if (section is null)
            {
                Error("text", $"Settings before the first section: {Truncate(line)}");
                break;
            }
        }

        if (!sawInterface)
            Error("interface", "No [Interface] section found.");
        if (peers == 0)
            Error("peer", "No [Peer] section found.");

        int? mtuValue = null;
        if (mtu is not null)
        {
            if (int.TryParse(mtu, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
                mtuValue = parsed;
            else
                Error("mtu", $"'{mtu}' is not a number.");
        }
        int? keepaliveValue = null;
        if (keepalive is not null)
        {
            if (int.TryParse(keepalive, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parsed))
                keepaliveValue = parsed;
            else
                Error("keepalive", $"'{keepalive}' is not a number.");
        }

        var endpointHost = string.Empty;
        if (endpoint is not null)
            TunnelValidation.TryNormalizeEndpoint(endpoint, 51820, out _, out endpointHost, out _);
        var detectedPreset = TunnelPresets.Detect(endpointHost, dns);
        var preset = TunnelPresets.Find(detectedPreset)!;

        var raw = new TunnelWrite
        {
            Name = preset.Name,
            Preset = detectedPreset,
            Enabled = true,
            PrivateKey = privateKey,
            Addresses = addresses,
            Dns = dns,
            Mtu = mtuValue,
            Keepalive = keepaliveValue,
            PeerPublicKey = publicKey ?? string.Empty,
            PresharedKey = presharedKey,
            Endpoint = endpoint ?? string.Empty,
            AllowedIps = allowedIps,
        };

        var validation = TunnelValidation.Validate(raw, requirePrivateKey: true, requireName: false, out var normalized);
        foreach (var problem in validation)
        {
            if (!errors.Any(e => e.Field == problem.Field))
                errors.Add(problem);
        }

        var prefill = errors.Count == 0
            ? raw with
            {
                PrivateKey = normalized.PrivateKey,
                Addresses = normalized.Addresses,
                Dns = normalized.Dns,
                Keepalive = normalized.Keepalive,
                PeerPublicKey = normalized.PeerPublicKey,
                PresharedKey = normalized.PresharedKey,
                Endpoint = normalized.Endpoint,
                AllowedIps = normalized.AllowedIps,
            }
            : raw;
        return Result(prefill, errors, warnings, detectedPreset);
    }

    private static TunnelImportResponse Result(TunnelWrite tunnel, List<TunnelFieldError> errors, List<string> warnings, string preset) => new()
    {
        Valid = errors.Count == 0,
        Tunnel = tunnel,
        DetectedPreset = preset,
        Errors = errors,
        Warnings = warnings,
    };

    private static TunnelWrite Empty() => new()
    {
        Name = string.Empty,
        Preset = TunnelPresets.Custom,
        PeerPublicKey = string.Empty,
        Endpoint = string.Empty,
        Addresses = [],
        Dns = [],
        AllowedIps = [],
    };

    private static IEnumerable<string> SplitList(string value)
        => value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string StripComment(string line)
    {
        var hash = line.IndexOf('#');
        var semicolon = line.IndexOf(';');
        var cut = hash < 0 ? semicolon : semicolon < 0 ? hash : Math.Min(hash, semicolon);
        return cut < 0 ? line : line[..cut];
    }

    private static string Truncate(string line)
    {
        var safe = new string(line.Where(c => !char.IsControl(c)).ToArray());
        return safe.Length <= 40 ? safe : safe[..40] + "…";
    }
}
