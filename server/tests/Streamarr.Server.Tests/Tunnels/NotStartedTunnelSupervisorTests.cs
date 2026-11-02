using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Options;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Security;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>The placeholder supervisor must keep every routed connection fail-closed until the real helper lands.</summary>
public sealed class NotStartedTunnelSupervisorTests : IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("streamarr-supervisor-");
    private readonly TunnelConfigService _tunnels;
    private readonly NotStartedTunnelSupervisor _supervisor;
    private readonly ManualClock _clock = new(new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero));
    private readonly StreamarrOptions _options = new();

    public NotStartedTunnelSupervisorTests()
    {
        var options = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(_directory.FullName, "tunnels.db")}")
            .Options;
        using (var setup = new StreamarrDbContext(options))
            setup.Database.EnsureCreated();
        _tunnels = new TunnelConfigService(new PooledDbContextFactory<StreamarrDbContext>(options), new PlainProtector(), _clock);
        _supervisor = new NotStartedTunnelSupervisor(_tunnels, _clock);
    }

    public void Dispose() => _directory.Delete(recursive: true);

    private static NormalizedTunnel Settings(string name) => new(
        name, "custom", "vpn.example:51820", ["10.0.0.2/32"], ["10.0.0.1"], null, null,
        TunnelValidationTests.PeerKey, ["0.0.0.0/0"], TunnelValidationTests.PrivateKey, null);

    [Fact]
    public async Task EnabledTunnelsAreDown_DisabledAreDisabled_AndSinceIsStable()
    {
        var on = await _tunnels.CreateAsync(Settings("on"), true, default);
        var off = await _tunnels.CreateAsync(Settings("off"), false, default);
        await _supervisor.ReloadAsync(default);
        var firstSeen = _clock.GetUtcNow();

        Assert.Equal(TunnelStates.Down, _supervisor.GetStatus(on.Id)!.State);
        Assert.Equal(NotStartedTunnelSupervisor.NotStartedError, _supervisor.GetStatus(on.Id)!.LastError);
        Assert.Equal(TunnelStates.Disabled, _supervisor.GetStatus(off.Id)!.State);
        Assert.Null(_supervisor.GetStatus(off.Id)!.LastError);
        Assert.Null(_supervisor.ProxyEndpoint(on.Id));
        Assert.Null(_supervisor.GetStatus("unknown"));

        _clock.Advance(TimeSpan.FromMinutes(5));
        await _supervisor.ReloadAsync(default);
        Assert.Equal(firstSeen, _supervisor.GetStatus(on.Id)!.Since);

        await _tunnels.UpdateAsync(off.Id, Settings("off"), enabled: true, false, default);
        await _supervisor.ReloadAsync(default);
        Assert.Equal(TunnelStates.Down, _supervisor.GetStatus(off.Id)!.State);
        Assert.Equal(_clock.GetUtcNow(), _supervisor.GetStatus(off.Id)!.Since);

        await _tunnels.DeleteAsync(on.Id, false, default);
        await _supervisor.ReloadAsync(default);
        Assert.Null(_supervisor.GetStatus(on.Id));
        Assert.Single(_supervisor.Snapshot());
    }

    [Fact]
    public async Task Test_FailsClosed()
    {
        var on = await _tunnels.CreateAsync(Settings("on"), true, default);
        var result = await _supervisor.TestAsync(on.Id, default);
        Assert.False(result.Success);
        Assert.False(result.HandshakeOk);
        Assert.Equal(TunnelStates.Down, result.State);
        Assert.Equal(NotStartedTunnelSupervisor.NotStartedError, result.Error);
    }

    [Fact]
    public async Task RouteResolver_DescribesDirectTunnelAndExternalProxy()
    {
        var on = await _tunnels.CreateAsync(Settings("Mullvad"), true, default);
        await _supervisor.ReloadAsync(default);
        var resolver = new OutboundRouteResolver(_tunnels, _supervisor, Microsoft.Extensions.Options.Options.Create(_options));

        var direct = await resolver.ForProviderAsync(null, default);
        Assert.Equal(RouteInfo.Direct, direct.Kind);
        Assert.True(direct.Usable);

        var tunnel = await resolver.ForProviderAsync(on.Id, default);
        Assert.Equal(RouteInfo.Tunnel, tunnel.Kind);
        Assert.Equal("Mullvad", tunnel.TunnelName);
        Assert.Equal(TunnelStates.Down, tunnel.State);
        Assert.False(tunnel.Usable);
        Assert.Equal(NotStartedTunnelSupervisor.NotStartedError, tunnel.LastError);
        var error = Assert.Throws<TunnelUnavailableException>(() => OutboundRouteResolver.EnsureUsable(tunnel));
        Assert.Equal("VPN down: tunnel 'Mullvad' is down (helper not started yet).", error.Message);
        Assert.Equal(on.Id, error.TunnelId);

        var unknown = await resolver.ForIndexerAsync("missing", default);
        Assert.False(unknown.Usable);
        Assert.Null(unknown.TunnelName);
        Assert.Equal("unknown tunnel", unknown.LastError);

        Assert.Equal(RouteInfo.Direct, (await resolver.ForIndexerAsync(null, default)).Kind);
        _options.IndexerProxy = "http://gluetun:8888";
        var proxied = await resolver.ForIndexerAsync(null, default);
        Assert.Equal(RouteInfo.ExternalProxy, proxied.Kind);
        Assert.True(proxied.Usable);
        Assert.Equal(RouteInfo.Tunnel, (await resolver.ForIndexerAsync(on.Id, default)).Kind);
        Assert.Equal(RouteInfo.Direct, (await resolver.ForProviderAsync(null, default)).Kind);
    }

    private sealed class PlainProtector : ISecretProtector
    {
        public string? Protect(string? plaintext) => string.IsNullOrEmpty(plaintext) ? null : "p:" + plaintext;
        public string Unprotect(string? ciphertext) => ciphertext?.StartsWith("p:", StringComparison.Ordinal) == true ? ciphertext[2..] : string.Empty;
    }
}
