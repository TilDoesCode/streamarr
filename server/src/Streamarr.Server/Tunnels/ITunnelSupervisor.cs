using System.Net;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// Owns one <c>streamarr-tunnel</c> helper process per enabled tunnel and knows each tunnel's live state. Routing code
/// asks it for the loopback SOCKS5 endpoint; the config API tells it to re-read the stored tunnels after a change.
/// </summary>
public interface ITunnelSupervisor
{
    /// <summary>The current status of a tunnel, or null when the supervisor does not know the id.</summary>
    TunnelStatus? GetStatus(string tunnelId);

    /// <summary>Status of every known tunnel.</summary>
    IReadOnlyDictionary<string, TunnelStatus> Snapshot();

    /// <summary>The tunnel's loopback SOCKS5 endpoint while it is <c>connected</c>; null otherwise (callers fail closed).</summary>
    IPEndPoint? ProxyEndpoint(string tunnelId);

    /// <summary>Re-reads the stored tunnels and starts, stops or restarts helpers to match.</summary>
    Task ReloadAsync(CancellationToken ct);

    /// <summary>Makes sure the helper runs, then checks handshake and exit IP through the tunnel.</summary>
    Task<TunnelTestResult> TestAsync(string tunnelId, CancellationToken ct);
}
