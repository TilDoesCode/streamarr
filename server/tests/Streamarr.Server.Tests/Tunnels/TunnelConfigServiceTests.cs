using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

public sealed class TunnelConfigServiceTests : IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("streamarr-tunnels-");
    private readonly DbContextOptions<StreamarrDbContext> _options;
    private readonly PooledDbContextFactory<StreamarrDbContext> _factory;
    private readonly PrefixSecretProtector _protector = new();
    private readonly ManualClock _clock = new(new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero));
    private readonly TunnelConfigService _service;

    public TunnelConfigServiceTests()
    {
        _options = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(_directory.FullName, "tunnels.db")}")
            .Options;
        using (var setup = new StreamarrDbContext(_options))
            setup.Database.EnsureCreated();
        _factory = new PooledDbContextFactory<StreamarrDbContext>(_options);
        _service = new TunnelConfigService(_factory, _protector, _clock);
    }

    public void Dispose() => _directory.Delete(recursive: true);

    private static NormalizedTunnel Settings(string name = "Mullvad", string? privateKey = TunnelValidationTests.PrivateKey, string? psk = null) => new(
        name, "mullvad", "185.65.134.86:51820", ["10.64.12.3/32"], ["10.64.0.1"], null, null,
        TunnelValidationTests.PeerKey, ["0.0.0.0/0", "::/0"], privateKey, psk);

    [Fact]
    public async Task Create_EncryptsSecretsAtRest_AndDerivesPublicKey()
    {
        var entity = await _service.CreateAsync(Settings(psk: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="), enabled: true, default);

        await using var db = new StreamarrDbContext(_options);
        var stored = await db.Tunnels.SingleAsync(t => t.Id == entity.Id);
        Assert.StartsWith("protected:", stored.PrivateKeyEncrypted);
        Assert.StartsWith("protected:", stored.PresharedKeyEncrypted);
        Assert.DoesNotContain(TunnelValidationTests.PrivateKey, stored.PrivateKeyEncrypted!.Replace("protected:" + TunnelValidationTests.PrivateKey, "x"));
        Assert.Equal(TunnelValidationTests.PrivateKey, _service.PrivateKey(stored));
        Assert.Equal("hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", _service.PublicKey(stored));
        Assert.Equal(TunnelConfigService.FirstLocalPort, stored.LocalPort);
        Assert.Equal(_clock.GetUtcNow(), stored.CreatedAt);

        var response = _service.ToResponse(stored, new TunnelStatus { State = TunnelStates.Down, Since = _clock.GetUtcNow() }, TunnelUsage.Empty);
        Assert.True(response.HasPrivateKey);
        Assert.True(response.HasPresharedKey);
        Assert.Equal("hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", response.PublicKey);
        Assert.Equal(["10.64.12.3/32"], response.Addresses);
        Assert.Equal(["0.0.0.0/0", "::/0"], response.AllowedIps);
    }

    [Fact]
    public async Task Create_AssignsDistinctFixedPorts()
    {
        var first = await _service.CreateAsync(Settings("a"), true, default);
        var second = await _service.CreateAsync(Settings("b"), true, default);
        Assert.Equal(TunnelConfigService.FirstLocalPort, first.LocalPort);
        Assert.Equal(TunnelConfigService.FirstLocalPort + 1, second.LocalPort);

        await _service.DeleteAsync(first.Id, force: false, default);
        var third = await _service.CreateAsync(Settings("c"), true, default);
        Assert.Equal(TunnelConfigService.FirstLocalPort, third.LocalPort);
    }

    [Fact]
    public async Task Update_KeepsPrivateKeyWhenOmitted_AndClearsPresharedKeyOnRequest()
    {
        var entity = await _service.CreateAsync(Settings(psk: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE="), true, default);
        _clock.Advance(TimeSpan.FromMinutes(1));

        var updated = await _service.UpdateAsync(entity.Id, Settings("Renamed", privateKey: null) with { Endpoint = "1.2.3.4:51820" }, enabled: false, clearPresharedKey: false, default);

        Assert.NotNull(updated);
        Assert.Equal("Renamed", updated!.Name);
        Assert.Equal("1.2.3.4:51820", updated.Endpoint);
        Assert.False(updated.Enabled);
        Assert.Equal(TunnelValidationTests.PrivateKey, _service.PrivateKey(updated));
        Assert.NotNull(updated.PresharedKeyEncrypted);
        Assert.Equal(entity.LocalPort, updated.LocalPort);
        Assert.Equal(_clock.GetUtcNow(), updated.UpdatedAt);

        var cleared = await _service.UpdateAsync(entity.Id, Settings("Renamed", privateKey: null), enabled: null, clearPresharedKey: true, default);
        Assert.Null(cleared!.PresharedKeyEncrypted);
        Assert.False(cleared.Enabled);

        var rotated = await _service.UpdateAsync(entity.Id, Settings("Renamed", privateKey: "XasIfmJKikt54X+Lg4AO5m87sSkmGLb9HC+LJ/+I4Os="), null, false, default);
        Assert.Equal("3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=", _service.PublicKey(rotated!));

        Assert.Null(await _service.UpdateAsync("missing", Settings(), null, false, default));
    }

    [Fact]
    public async Task Delete_RefusesWhileInUse_AndForceSetsDependentsToDirect()
    {
        var tunnel = await _service.CreateAsync(Settings(), true, default);
        await using (var db = new StreamarrDbContext(_options))
        {
            db.Providers.Add(new ProviderEntity { Id = "p1", Name = "Eweka", Host = "news.eweka.nl", TunnelId = tunnel.Id });
            db.Providers.Add(new ProviderEntity { Id = "p2", Name = "Direct", Host = "news.direct.example" });
            db.Indexers.Add(new IndexerEntity { Id = "i1", Name = "NZBGeek", BaseUrl = "https://api.nzbgeek.info", TunnelId = tunnel.Id });
            await db.SaveChangesAsync();
        }

        var usage = await _service.UsageAsync(tunnel.Id, default);
        Assert.Equal(["Eweka"], usage.Providers.Select(p => p.Name));
        Assert.Equal(["NZBGeek"], usage.Indexers.Select(i => i.Name));
        Assert.Empty((await _service.UsageMapAsync(default)).Keys.Where(k => k != tunnel.Id));

        var (refused, refusedUsage) = await _service.DeleteAsync(tunnel.Id, force: false, default);
        Assert.Equal(TunnelDeleteOutcome.InUse, refused);
        Assert.Single(refusedUsage.Providers);
        Assert.True(await _service.ExistsAsync(tunnel.Id, default));

        var (deleted, _) = await _service.DeleteAsync(tunnel.Id, force: true, default);
        Assert.Equal(TunnelDeleteOutcome.Deleted, deleted);
        Assert.False(await _service.ExistsAsync(tunnel.Id, default));

        await using (var db = new StreamarrDbContext(_options))
        {
            Assert.Null((await db.Providers.SingleAsync(p => p.Id == "p1")).TunnelId);
            Assert.Null((await db.Indexers.SingleAsync(i => i.Id == "i1")).TunnelId);
        }

        Assert.Equal(TunnelDeleteOutcome.NotFound, (await _service.DeleteAsync(tunnel.Id, false, default)).Outcome);
    }

    [Fact]
    public async Task NameMap_ListsEveryTunnel()
    {
        var a = await _service.CreateAsync(Settings("Zeta"), true, default);
        var b = await _service.CreateAsync(Settings("Alpha"), false, default);
        var names = await _service.NameMapAsync(default);
        Assert.Equal("Zeta", names[a.Id]);
        Assert.Equal("Alpha", names[b.Id]);
        Assert.Equal(["Alpha", "Zeta"], (await _service.ListAsync(default)).Select(t => t.Name));
    }

    [Fact]
    public async Task LostKeyRing_YieldsNoPublicKey()
    {
        var entity = await _service.CreateAsync(Settings(), true, default);
        entity.PrivateKeyEncrypted = "garbage";
        Assert.Null(_service.PublicKey(entity));
        Assert.Equal(string.Empty, _service.PrivateKey(entity));
    }

    private sealed class PrefixSecretProtector : ISecretProtector
    {
        public string? Protect(string? plaintext) => string.IsNullOrEmpty(plaintext) ? null : $"protected:{plaintext}";

        public string Unprotect(string? ciphertext)
            => ciphertext?.StartsWith("protected:", StringComparison.Ordinal) == true ? ciphertext["protected:".Length..] : string.Empty;
    }
}
