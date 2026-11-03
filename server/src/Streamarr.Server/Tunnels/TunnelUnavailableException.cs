namespace Streamarr.Server.Tunnels;

/// <summary>
/// Thrown instead of opening a connection when the tunnel a provider or indexer is routed through is not connected.
/// Routing never falls back to a direct connection (docs/vpn.md); callers surface this as "VPN down".
/// </summary>
public sealed class TunnelUnavailableException(string tunnelId, string? tunnelName, string state, string? lastError)
    : Exception(Describe(tunnelName, state, lastError))
{
    /// <summary>Machine-readable code used by test and diagnostics payloads.</summary>
    public const string Code = "vpn_down";

    public string TunnelId { get; } = tunnelId;
    public string? TunnelName { get; } = tunnelName;
    public string State { get; } = state;
    public string? LastError { get; } = lastError;

    public static string Describe(string? tunnelName, string state, string? lastError)
    {
        var name = string.IsNullOrEmpty(tunnelName) ? "the tunnel" : $"tunnel '{tunnelName}'";
        return string.IsNullOrEmpty(lastError)
            ? $"VPN down: {name} is {state}."
            : $"VPN down: {name} is {state} ({lastError}).";
    }
}
