using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// Describes how a provider's or indexer's connections leave the server: direct, through a tunnel, or through the
/// legacy indexer HTTP proxy. A tunnel route is usable only while the tunnel is <c>connected</c>; nothing ever falls
/// back to direct (docs/vpn.md).
/// </summary>
public sealed class OutboundRouteResolver(
    TunnelConfigService tunnels,
    ITunnelSupervisor supervisor,
    IOptions<StreamarrOptions> options)
{
    /// <summary>One consistent view of tunnel names and states for describing many routes.</summary>
    public async Task<RouteTable> SnapshotAsync(CancellationToken ct)
        => new(await tunnels.NameMapAsync(ct), supervisor.Snapshot(), !string.IsNullOrEmpty(options.Value.IndexerProxy));

    public async Task<RouteInfo> ForProviderAsync(string? tunnelId, CancellationToken ct)
        => (await SnapshotAsync(ct)).ForProvider(tunnelId);

    public async Task<RouteInfo> ForIndexerAsync(string? tunnelId, CancellationToken ct)
        => (await SnapshotAsync(ct)).ForIndexer(tunnelId);

    /// <summary>Throws <see cref="TunnelUnavailableException"/> unless connections over <paramref name="route"/> may be opened.</summary>
    public static void EnsureUsable(RouteInfo route)
    {
        if (!route.Usable)
            throw Unavailable(route);
    }

    public static TunnelUnavailableException Unavailable(RouteInfo route)
        => new(route.TunnelId ?? string.Empty, route.TunnelName, route.State ?? TunnelStates.Down, route.LastError);
}

/// <summary>Point-in-time route descriptions (see <see cref="OutboundRouteResolver"/>).</summary>
public sealed class RouteTable(
    IReadOnlyDictionary<string, string> tunnelNames,
    IReadOnlyDictionary<string, TunnelStatus> statuses,
    bool externalIndexerProxy)
{
    public static readonly RouteInfo DirectRoute = new() { Kind = RouteInfo.Direct, Usable = true };
    public static readonly RouteInfo ExternalProxyRoute = new() { Kind = RouteInfo.ExternalProxy, Usable = true };

    public RouteInfo ForProvider(string? tunnelId) => Describe(tunnelId, DirectRoute);

    /// <summary>A tunnel on the indexer takes precedence over the legacy INDEXER_PROXY.</summary>
    public RouteInfo ForIndexer(string? tunnelId) => Describe(tunnelId, externalIndexerProxy ? ExternalProxyRoute : DirectRoute);

    private RouteInfo Describe(string? tunnelId, RouteInfo fallback)
    {
        if (string.IsNullOrEmpty(tunnelId))
            return fallback;
        tunnelNames.TryGetValue(tunnelId, out var name);
        statuses.TryGetValue(tunnelId, out var status);
        var state = status?.State ?? TunnelStates.Down;
        return new RouteInfo
        {
            Kind = RouteInfo.Tunnel,
            TunnelId = tunnelId,
            TunnelName = name,
            State = state,
            Usable = TunnelStates.IsUsable(state),
            LastError = status?.LastError ?? (name is null ? "unknown tunnel" : status is null ? "tunnel status unknown" : null),
        };
    }
}
