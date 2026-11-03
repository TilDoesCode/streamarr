using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Streamarr.Tests.Shared;

/// <summary>One CONNECT request a <see cref="FakeSocks5Server"/> received, as the client encoded it.</summary>
public sealed record Socks5ConnectRequest(byte AddressType, string Host, int Port);

/// <summary>
/// In-process SOCKS5 server (no auth, CONNECT only) that records every request and bridges accepted connections
/// to a target chosen by <see cref="Resolve"/>. Stands in for the tunnel helper so tests can prove clients send
/// hostnames (ATYP 3) instead of resolving them locally.
/// </summary>
public sealed class FakeSocks5Server : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _clients = [];
    private readonly Task _accept;

    public FakeSocks5Server()
    {
        _listener.Start();
        _accept = AcceptLoopAsync();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public IPEndPoint EndPoint => new(IPAddress.Loopback, Port);

    public ConcurrentQueue<Socks5ConnectRequest> Requests { get; } = new();

    /// <summary>Maps the requested host:port to the real target; null answers "host unreachable" (0x04).</summary>
    public Func<string, int, IPEndPoint?> Resolve { get; set; } = (host, port) =>
        IPAddress.TryParse(host, out var ip) ? new IPEndPoint(ip, port) : null;

    /// <summary>When set, every CONNECT is answered with this reply code and closed.</summary>
    public byte? ForcedReply { get; set; }

    /// <summary>When set, the greeting demands username/password (0x02) so no-auth clients must give up.</summary>
    public bool RequireAuth { get; set; }

    private async Task AcceptLoopAsync()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_cts.Token);
                lock (_clients)
                    _clients.Add(Task.Run(() => HandleAsync(client)));
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (SocketException)
        {
        }
    }

    private async Task HandleAsync(TcpClient client)
    {
        using (client)
        {
            var stream = client.GetStream();
            try
            {
                var greeting = new byte[2];
                await stream.ReadExactlyAsync(greeting, _cts.Token);
                var methods = new byte[greeting[1]];
                await stream.ReadExactlyAsync(methods, _cts.Token);
                if (greeting[0] != 5 || RequireAuth || !methods.Contains((byte)0))
                {
                    await stream.WriteAsync(new byte[] { 5, 0xFF }, _cts.Token);
                    return;
                }
                await stream.WriteAsync(new byte[] { 5, 0 }, _cts.Token);

                var head = new byte[4];
                await stream.ReadExactlyAsync(head, _cts.Token);
                string host;
                switch (head[3])
                {
                    case 1:
                        var v4 = new byte[4];
                        await stream.ReadExactlyAsync(v4, _cts.Token);
                        host = new IPAddress(v4).ToString();
                        break;
                    case 4:
                        var v6 = new byte[16];
                        await stream.ReadExactlyAsync(v6, _cts.Token);
                        host = new IPAddress(v6).ToString();
                        break;
                    case 3:
                        var len = new byte[1];
                        await stream.ReadExactlyAsync(len, _cts.Token);
                        var name = new byte[len[0]];
                        await stream.ReadExactlyAsync(name, _cts.Token);
                        host = Encoding.ASCII.GetString(name);
                        break;
                    default:
                        await Reply(stream, 0x08);
                        return;
                }
                var portBytes = new byte[2];
                await stream.ReadExactlyAsync(portBytes, _cts.Token);
                var port = BinaryPrimitives.ReadUInt16BigEndian(portBytes);
                Requests.Enqueue(new Socks5ConnectRequest(head[3], host, port));

                if (head[1] != 1)
                {
                    await Reply(stream, 0x07);
                    return;
                }
                if (ForcedReply is { } forced)
                {
                    await Reply(stream, forced);
                    return;
                }
                var target = Resolve(host, port);
                if (target is null)
                {
                    await Reply(stream, 0x04);
                    return;
                }

                using var upstream = new TcpClient();
                try
                {
                    await upstream.ConnectAsync(target, _cts.Token);
                }
                catch (SocketException)
                {
                    await Reply(stream, 0x05);
                    return;
                }
                await Reply(stream, 0x00);
                var up = upstream.GetStream();
                var a = stream.CopyToAsync(up, _cts.Token);
                var b = up.CopyToAsync(stream, _cts.Token);
                await Task.WhenAny(a, b);
            }
            catch (Exception e) when (e is IOException or SocketException or OperationCanceledException or EndOfStreamException or ObjectDisposedException)
            {
            }
        }
    }

    private async Task Reply(Stream stream, byte code)
    {
        await stream.WriteAsync(new byte[] { 5, code, 0, 1, 0, 0, 0, 0, 0, 0 }, _cts.Token);
        await stream.FlushAsync(_cts.Token);
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _listener.Stop();
        try
        {
            await _accept;
        }
        catch (Exception e) when (e is OperationCanceledException or SocketException or ObjectDisposedException)
        {
        }
        Task[] clients;
        lock (_clients)
            clients = _clients.ToArray();
        await Task.WhenAll(clients.Select(t => t.ContinueWith(_ => { }, TaskScheduler.Default)));
        _cts.Dispose();
    }
}
