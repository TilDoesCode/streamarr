using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Streamarr.Usenet.Net;

/// <summary>
/// Minimal SOCKS5 client (RFC 1928): "no authentication" greeting plus one CONNECT. The destination is sent
/// as a domain name unless it is an IP literal, so the proxy (the tunnel helper) resolves it and the host
/// resolver never sees provider hostnames.
/// </summary>
public static class Socks5Client
{
    private const byte Version = 0x05;
    private const byte NoAuth = 0x00;
    private const byte CmdConnect = 0x01;
    private const byte AtypIPv4 = 0x01;
    private const byte AtypDomain = 0x03;
    private const byte AtypIPv6 = 0x04;

    /// <summary>Negotiates and connects on an already open stream to the proxy; the stream then carries the destination's bytes.</summary>
    public static async Task ConnectAsync(Stream stream, string host, int port, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(stream);
        await stream.WriteAsync(new byte[] { Version, 1, NoAuth }, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);

        var method = new byte[2];
        await stream.ReadExactlyAsync(method, ct).ConfigureAwait(false);
        if (method[0] != Version)
            throw new Socks5Exception("The proxy did not answer with SOCKS version 5.");
        if (method[1] != NoAuth)
            throw new Socks5Exception("The proxy requires an authentication method Streamarr does not support.");

        await stream.WriteAsync(BuildConnectRequest(host, port), ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);

        var head = new byte[4];
        await stream.ReadExactlyAsync(head, ct).ConfigureAwait(false);
        if (head[0] != Version)
            throw new Socks5Exception("The proxy sent an invalid CONNECT reply.");
        if (head[1] != 0x00)
            throw new Socks5Exception(DescribeReply(head[1])) { ReplyCode = head[1] };

        int addressLength;
        switch (head[3])
        {
            case AtypIPv4:
                addressLength = 4;
                break;
            case AtypIPv6:
                addressLength = 16;
                break;
            case AtypDomain:
                var length = new byte[1];
                await stream.ReadExactlyAsync(length, ct).ConfigureAwait(false);
                addressLength = length[0];
                break;
            default:
                throw new Socks5Exception("The proxy sent an unknown bound address type.");
        }
        await stream.ReadExactlyAsync(new byte[addressLength + 2], ct).ConfigureAwait(false);
    }

    /// <summary>VER CMD RSV ATYP DST.ADDR DST.PORT; IP literals go as IPv4/IPv6, everything else as a domain name.</summary>
    internal static byte[] BuildConnectRequest(string host, int port)
    {
        if (string.IsNullOrWhiteSpace(host))
            throw new ArgumentException("A destination host is required.", nameof(host));
        if (port is < 1 or > 65535)
            throw new ArgumentOutOfRangeException(nameof(port));

        var trimmed = host.Trim().TrimStart('[').TrimEnd(']');
        byte[] address;
        byte atyp;
        if (IPAddress.TryParse(trimmed, out var ip) && ip.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
        {
            address = ip.GetAddressBytes();
            atyp = ip.AddressFamily == AddressFamily.InterNetwork ? AtypIPv4 : AtypIPv6;
        }
        else
        {
            var name = Encoding.ASCII.GetBytes(trimmed);
            if (name.Length is 0 or > 255 || trimmed.Any(c => c > 127))
                throw new ArgumentException("The destination host must be an ASCII name of at most 255 bytes.", nameof(host));
            address = new byte[name.Length + 1];
            address[0] = (byte)name.Length;
            name.CopyTo(address, 1);
            atyp = AtypDomain;
        }

        var request = new byte[4 + address.Length + 2];
        request[0] = Version;
        request[1] = CmdConnect;
        request[2] = 0x00;
        request[3] = atyp;
        address.CopyTo(request, 4);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(4 + address.Length), (ushort)port);
        return request;
    }

    public static string DescribeReply(byte code) => code switch
    {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by the proxy",
        0x03 => "network unreachable through the tunnel",
        0x04 => "host unreachable through the tunnel (name resolution or routing failed)",
        0x05 => "connection refused by the destination",
        0x06 => "TTL expired",
        0x07 => "command not supported by the proxy",
        0x08 => "address type not supported by the proxy",
        _ => $"SOCKS5 reply code {code}",
    };
}

/// <summary>A SOCKS5 negotiation or CONNECT failure; <see cref="ReplyCode"/> is the proxy's reply when it answered.</summary>
public sealed class Socks5Exception(string message) : IOException(message)
{
    public byte? ReplyCode { get; init; }
}
