using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

public sealed class WireGuardConfParserTests
{
    private const string Mullvad = """
        [Interface]
        # Device: Quiet Otter
        PrivateKey = dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=
        Address = 10.64.12.3/32,fc00:bbbb:bbbb:bb01::1:c02/128
        DNS = 10.64.0.1

        [Peer]
        PublicKey = 3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=
        AllowedIPs = 0.0.0.0/0,::0/0
        Endpoint = 185.65.134.86:51820
        """;

    [Fact]
    public void MullvadConf_IsRecognisedByDns_AndPrefilled()
    {
        var result = WireGuardConfParser.Parse(Mullvad);

        Assert.True(result.Valid, string.Join("; ", result.Errors.Select(e => $"{e.Field}: {e.Message}")));
        Assert.Equal("mullvad", result.DetectedPreset);
        Assert.Equal("mullvad", result.Tunnel.Preset);
        Assert.Equal("Mullvad VPN", result.Tunnel.Name);
        Assert.Equal(TunnelValidationTests.PrivateKey, result.Tunnel.PrivateKey);
        Assert.Equal(TunnelValidationTests.PeerKey, result.Tunnel.PeerPublicKey);
        Assert.Equal(["10.64.12.3/32", "fc00:bbbb:bbbb:bb01::1:c02/128"], result.Tunnel.Addresses);
        Assert.Equal(["10.64.0.1"], result.Tunnel.Dns);
        Assert.Equal(["0.0.0.0/0", "::/0"], result.Tunnel.AllowedIps);
        Assert.Equal("185.65.134.86:51820", result.Tunnel.Endpoint);
        Assert.Null(result.Tunnel.PresharedKey);
        Assert.Empty(result.Warnings);
    }

    [Fact]
    public void ProtonConf_WithScriptsAndSearchDomain_WarnsButImports()
    {
        var text = """
            [Interface]
            PrivateKey = dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo= ; generated
            Address = 10.2.0.2/32
            DNS = 10.2.0.1, corp.example
            MTU = 1420
            PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -j REJECT
            Table = off

            [Peer]
            PublicKey = 3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=
            PresharedKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=
            AllowedIPs = 0.0.0.0/0
            Endpoint = node-ch-01.protonvpn.net:51820
            PersistentKeepalive = 25
            """;

        var result = WireGuardConfParser.Parse(text);

        Assert.True(result.Valid);
        Assert.Equal("protonvpn", result.DetectedPreset);
        Assert.Equal(1420, result.Tunnel.Mtu);
        Assert.Equal(25, result.Tunnel.Keepalive);
        Assert.Equal("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=", result.Tunnel.PresharedKey);
        Assert.Equal(["0.0.0.0/0"], result.Tunnel.AllowedIps);
        Assert.Equal("node-ch-01.protonvpn.net:51820", result.Tunnel.Endpoint);
        Assert.Contains(result.Warnings, w => w.Contains("corp.example"));
        Assert.Contains(result.Warnings, w => w.StartsWith("PostUp"));
        Assert.Contains(result.Warnings, w => w.StartsWith("Table"));
    }

    [Fact]
    public void UnknownProvider_IsCustom()
    {
        var text = Mullvad.Replace("10.64.0.1", "9.9.9.9").Replace("185.65.134.86:51820", "wg.example.org:443");
        var result = WireGuardConfParser.Parse(text);
        Assert.True(result.Valid);
        Assert.Equal("custom", result.DetectedPreset);
        Assert.Equal("Custom WireGuard", result.Tunnel.Name);
        Assert.Equal("wg.example.org:443", result.Tunnel.Endpoint);
    }

    [Fact]
    public void MissingSections_AndBadValues_AreFieldErrors()
    {
        var result = WireGuardConfParser.Parse("""
            [Interface]
            PrivateKey = short
            MTU = big
            """);

        Assert.False(result.Valid);
        var fields = result.Errors.Select(e => e.Field).ToList();
        Assert.Contains("peer", fields);
        Assert.Contains("privateKey", fields);
        Assert.Contains("mtu", fields);
        Assert.Contains("addresses", fields);
        Assert.Contains("dns", fields);
        Assert.Contains("peerPublicKey", fields);
        Assert.Contains("endpoint", fields);
        Assert.Equal("custom", result.DetectedPreset);
    }

    [Fact]
    public void SecondPeer_IsAnError_AndFirstIsUsed()
    {
        var result = WireGuardConfParser.Parse(Mullvad + "\n[Peer]\nPublicKey = dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=\nEndpoint = other:1\n");
        Assert.False(result.Valid);
        Assert.Equal("peer", Assert.Single(result.Errors).Field);
        Assert.Equal("185.65.134.86:51820", result.Tunnel.Endpoint);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   \n ")]
    public void EmptyText_IsAnError(string? text)
    {
        var result = WireGuardConfParser.Parse(text);
        Assert.False(result.Valid);
        Assert.Equal("text", Assert.Single(result.Errors).Field);
    }

    [Fact]
    public void SettingsBeforeAnySection_AreRejected()
    {
        var result = WireGuardConfParser.Parse("PrivateKey = x\n" + Mullvad);
        Assert.Contains(result.Errors, e => e.Field == "text");
    }

    [Fact]
    public void OversizedText_IsRejected()
    {
        var result = WireGuardConfParser.Parse(new string('#', WireGuardConfParser.MaxTextLength + 1));
        Assert.Equal("text", Assert.Single(result.Errors).Field);
    }
}
