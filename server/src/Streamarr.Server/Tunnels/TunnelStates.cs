namespace Streamarr.Server.Tunnels;

/// <summary>Runtime states of a tunnel as reported by the supervisor (docs/vpn.md).</summary>
public static class TunnelStates
{
    /// <summary>The tunnel is switched off; routed connections fail closed.</summary>
    public const string Disabled = "disabled";

    /// <summary>The helper is starting or waiting for the first handshake.</summary>
    public const string Starting = "starting";

    /// <summary>Handshake is fresh and the exit works; routed connections are allowed.</summary>
    public const string Connected = "connected";

    /// <summary>Was connected but the handshake is stale or the exit check failed; routed connections fail closed.</summary>
    public const string Degraded = "degraded";

    /// <summary>Not connected (helper missing, crashed, or never handshook); routed connections fail closed.</summary>
    public const string Down = "down";

    /// <summary>Only <see cref="Connected"/> lets traffic through (never fall back to direct).</summary>
    public static bool IsUsable(string? state) => state == Connected;
}
