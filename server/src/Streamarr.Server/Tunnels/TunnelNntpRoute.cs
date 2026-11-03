using System.Net;
using Streamarr.Usenet.Models;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// NNTP route through a Streamarr tunnel: every new provider connection asks the supervisor for the tunnel's SOCKS5
/// endpoint and throws <see cref="TunnelUnavailableException"/> while the tunnel is not connected (fail closed).
/// </summary>
public sealed class TunnelNntpRoute(ITunnelSupervisor supervisor, string tunnelId) : NntpConnectionRoute
{
    public string TunnelId { get; } = tunnelId;

    public override IPEndPoint? ResolveProxy()
        => supervisor.ProxyEndpoint(TunnelId) ?? throw supervisor.Unavailable(TunnelId);

    public override string ToString() => $"tunnel:{TunnelId}";

    /// <summary>Attaches the live route for the provider's <see cref="UsenetProvider.TunnelId"/>; direct providers are returned unchanged.</summary>
    public static UsenetProvider Attach(UsenetProvider provider, ITunnelSupervisor supervisor)
        => string.IsNullOrEmpty(provider.TunnelId) ? provider : provider with { Route = new TunnelNntpRoute(supervisor, provider.TunnelId) };
}
