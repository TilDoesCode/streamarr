using System.Net;

namespace Streamarr.Usenet.Models;

/// <summary>
/// How new connections to a Usenet provider leave the host: directly, or through a SOCKS5 proxy on loopback
/// (a Streamarr VPN tunnel). Resolved for every new connection so a route can refuse to connect while its
/// tunnel is down instead of silently falling back to a direct connection.
/// </summary>
public abstract class NntpConnectionRoute
{
    public static NntpConnectionRoute Direct { get; } = new DirectRoute();

    /// <summary>A route through a fixed SOCKS5 proxy (tests and static setups).</summary>
    public static NntpConnectionRoute Socks5(IPEndPoint proxy) => new FixedSocks5Route(proxy);

    /// <summary>
    /// The SOCKS5 proxy to connect through right now, or null for a direct connection. Implementations throw
    /// when the route must not be used at the moment (fail closed); the exception reaches the caller that
    /// asked for the connection.
    /// </summary>
    public abstract IPEndPoint? ResolveProxy();

    /// <summary>True for routes that never use a proxy.</summary>
    public virtual bool IsDirect => false;

    private sealed class DirectRoute : NntpConnectionRoute
    {
        public override IPEndPoint? ResolveProxy() => null;
        public override bool IsDirect => true;
        public override string ToString() => "direct";
    }

    private sealed class FixedSocks5Route(IPEndPoint proxy) : NntpConnectionRoute
    {
        public override IPEndPoint? ResolveProxy() => proxy;
        public override string ToString() => $"socks5://{proxy}";
    }
}
