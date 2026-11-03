using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Services.Diagnostics;

namespace Streamarr.Server.Tests.Tunnels;

public sealed class TunnelDiagnosticsVerdictTests
{
    private static readonly DependencySnapshot Snapshot = new() { Indexers = [], Providers = [], CheckedAt = DateTimeOffset.UnixEpoch };

    private static DiagnosticsComponent C(string kind, string status, string? code = null, int n = 1)
        => new() { Id = $"{kind}:{n}", Kind = kind, Name = kind, Status = status, ErrorCode = code };

    private static List<DiagnosticsComponent> Healthy() =>
    [
        C("database", "ok"), C("metadata", "ok"), C("provider", "ok"), C("indexer", "ok"), C("disk", "ok"), C("streams", "ok"),
    ];

    [Fact]
    public void ConnectedTunnel_AddsNoHint()
    {
        var components = Healthy();
        components.Add(C("tunnel", "ok"));
        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("ok", status);
        Assert.Empty(hints);
    }

    [Fact]
    public void OnlyTunnelDown_IsDegradedWithTunnelDownFirst()
    {
        var components = Healthy();
        components.Add(C("tunnel", "down", "unreachable"));
        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("degraded", status);
        Assert.Equal(["tunnel_down"], hints);
    }

    [Fact]
    public void TunnelDown_ExplainsRoutedProvidersBeforeTheirOwnHint()
    {
        var components = Healthy();
        components[2] = C("provider", "down", "vpn_down");
        components.Add(C("tunnel", "down", "unreachable"));
        components.Add(C("tunnel", "ok", null, 2));
        var (status, hints) = DiagnosticsService.Verdict(components, Snapshot);
        Assert.Equal("down", status);
        Assert.Equal(["some_tunnels_down", "all_providers_down"], hints);
    }

    [Fact]
    public void TunnelComponents_DoNotJoinViewerCategories()
    {
        var components = Healthy();
        components.Add(C("tunnel", "down", "unreachable"));
        var evaluation = ServiceStatusTracker.Evaluate(components);
        Assert.Equal("ok", evaluation.State);
        Assert.Equal(components.Count - 1, evaluation.Categories.Sum(c => c.Total));
        Assert.All(evaluation.Categories, c => Assert.Equal(0, c.Affected));
    }
}
