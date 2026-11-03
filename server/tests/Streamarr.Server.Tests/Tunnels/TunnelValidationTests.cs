using Streamarr.Server.Contracts;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

public sealed class TunnelValidationTests
{
    public const string PrivateKey = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=";
    public const string PeerKey = "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=";

    private static TunnelWrite Valid() => new()
    {
        Name = "Mullvad SE",
        Preset = "mullvad",
        PrivateKey = PrivateKey,
        PeerPublicKey = PeerKey,
        Endpoint = "se-sto-wg-001.relays.mullvad.net:51820",
        Addresses = ["10.64.12.3/32", "fc00:bbbb:bbbb:bb01::1:c02"],
    };

    [Fact]
    public void ValidWrite_NormalizesAndFillsDefaults()
    {
        var errors = TunnelValidation.Validate(Valid(), requirePrivateKey: true, requireName: true, out var n);

        Assert.Empty(errors);
        Assert.Equal("mullvad", n.Preset);
        Assert.Equal("se-sto-wg-001.relays.mullvad.net:51820", n.Endpoint);
        Assert.Equal(["10.64.12.3/32", "fc00:bbbb:bbbb:bb01::1:c02/128"], n.Addresses);
        Assert.Equal(["10.64.0.1"], n.Dns);
        Assert.Equal(["0.0.0.0/0", "::/0"], n.AllowedIps);
        Assert.Null(n.Keepalive);
        Assert.Equal(PrivateKey, n.PrivateKey);
        Assert.Null(n.PresharedKey);
    }

    [Fact]
    public void CustomPreset_RequiresDns()
    {
        var write = Valid() with { Preset = null, Endpoint = "vpn.example.org" };
        var errors = TunnelValidation.Validate(write, true, true, out var n);
        Assert.Equal("dns", Assert.Single(errors).Field);
        Assert.Equal("custom", n.Preset);
        Assert.Equal("vpn.example.org:51820", n.Endpoint);
    }

    [Fact]
    public void MissingPrivateKey_IsOnlyAnErrorWhenRequired()
    {
        var write = Valid() with { PrivateKey = null };
        Assert.Contains(TunnelValidation.Validate(write, true, true, out _), e => e.Field == "privateKey");
        Assert.Empty(TunnelValidation.Validate(write, false, true, out var n));
        Assert.Null(n.PrivateKey);
    }

    [Theory]
    [InlineData("[2001:db8::1]:1234", "[2001:db8::1]:1234")]
    [InlineData("[2001:db8::1]", "[2001:db8::1]:51820")]
    [InlineData("185.65.134.86:51820", "185.65.134.86:51820")]
    [InlineData("VPN.Example.ORG:443", "vpn.example.org:443")]
    public void Endpoint_IsNormalized(string input, string expected)
    {
        var errors = TunnelValidation.Validate(Valid() with { Endpoint = input }, true, true, out var n);
        Assert.Empty(errors);
        Assert.Equal(expected, n.Endpoint);
    }

    [Theory]
    [InlineData("")]
    [InlineData("host:0")]
    [InlineData("host:70000")]
    [InlineData("2001:db8::1:51820")]
    [InlineData("bad host:51820")]
    [InlineData("http://host:51820")]
    public void Endpoint_Invalid(string input)
    {
        var errors = TunnelValidation.Validate(Valid() with { Endpoint = input }, true, true, out _);
        Assert.Contains(errors, e => e.Field == "endpoint");
    }

    [Fact]
    public void Keys_MustBeThirtyTwoBytes()
    {
        var errors = TunnelValidation.Validate(Valid() with { PrivateKey = "AAAA", PeerPublicKey = "nope", PresharedKey = "x" }, true, true, out _);
        Assert.Equal(["privateKey", "peerPublicKey", "presharedKey"], errors.Select(e => e.Field).OrderBy(f => f == "presharedKey" ? 2 : f == "peerPublicKey" ? 1 : 0));
    }

    [Fact]
    public void Ranges_AreEnforced()
    {
        var errors = TunnelValidation.Validate(Valid() with { Mtu = 100, Keepalive = 9999, Addresses = ["10.1.2.300/32"], Dns = ["dns.example"], AllowedIps = ["0.0.0.0/33"] }, true, true, out _);
        Assert.Equal(["addresses", "dns", "mtu", "keepalive", "allowedIps"], errors.Select(e => e.Field));
    }

    [Fact]
    public void UnknownPreset_IsReported_AndAddressesDeduplicated()
    {
        var errors = TunnelValidation.Validate(Valid() with { Preset = "nope", Addresses = ["10.0.0.2", "10.0.0.2/32"], Dns = ["1.1.1.1", "1.1.1.1"], Keepalive = 25 }, true, true, out var n);
        Assert.Equal("preset", Assert.Single(errors).Field);
        Assert.Equal(["10.0.0.2/32"], n.Addresses);
        Assert.Equal(["1.1.1.1"], n.Dns);
        Assert.Equal(25, n.Keepalive);
    }

    [Fact]
    public void Name_OnlyRequiredWhenAsked()
    {
        var write = Valid() with { Name = "" };
        Assert.Contains(TunnelValidation.Validate(write, true, true, out _), e => e.Field == "name");
        Assert.Empty(TunnelValidation.Validate(write, true, false, out _));
        Assert.Contains(TunnelValidation.Validate(Valid() with { Name = "bad\nname" }, true, true, out _), e => e.Field == "name");
    }
}
