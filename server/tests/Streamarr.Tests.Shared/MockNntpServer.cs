using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Streamarr.Tests.Shared;

/// <summary>
/// In-repo mock NNTP server (DECISIONS.md: all integration tests run against
/// this until real provider credentials exist). Speaks the subset of NNTP that
/// Streamarr uses: greeting, AUTHINFO USER/PASS, STAT, HEAD, BODY, ARTICLE,
/// DATE, QUIT — including dot-stuffing of body lines.
/// </summary>
public sealed class MockNntpServer : IAsyncDisposable
{
    private const int BodyWriterBufferChars = 64 * 1024;

    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _clients = [];
    private int _currentConnections;
    private int _maxObservedConnections;

    public MockNntpServer()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        _ = AcceptLoop();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public string Host => "127.0.0.1";

    public string Username { get; init; } = "user";
    public string Password { get; init; } = "pass";
    public bool RequireAuth { get; init; }

    /// <summary>
    /// When set, the provider pretends it no longer carries any article — STAT/BODY/ARTICLE
    /// answer 430 (as an exhausted / DMCA'd / block-expired provider would). Flipping this on
    /// mid-stream drives the multi-provider failover path (BRIEF §10-M7). Volatile so a test
    /// thread can toggle it while the server is serving.
    /// </summary>
    public volatile bool RejectBodies;

    /// <summary>Additional synthetic headers emitted by HEAD, for parser-bound tests.</summary>
    public int ExtraHeadHeaders { get; init; }

    /// <summary>message-id (no brackets) → raw yEnc article text (CRLF lines, not dot-stuffed).</summary>
    public ConcurrentDictionary<string, string> Articles { get; } = new();

    public int MaxObservedConnections => _maxObservedConnections;
    public int CommandsServed => _commandsServed;

    /// <summary>Article bodies this server actually delivered (BODY/ARTICLE 2xx).</summary>
    public int BodiesServed => _bodiesServed;

    private int _commandsServed;
    private int _bodiesServed;

    private async Task AcceptLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_cts.Token);
                lock (_clients)
                {
                    _clients.Add(HandleClient(client));
                }
            }
        }
        catch (OperationCanceledException)
        {
            // shutting down
        }
        catch (SocketException)
        {
            // listener disposed
        }
    }

    private async Task HandleClient(TcpClient client)
    {
        var current = Interlocked.Increment(ref _currentConnections);
        InterlockedMax(ref _maxObservedConnections, current);

        try
        {
            using var _ = client;
            await using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.Latin1);
            await using var writer = new StreamWriter(
                stream,
                Encoding.Latin1,
                BodyWriterBufferChars,
                leaveOpen: true)
            {
                AutoFlush = true,
            };

            await writer.WriteAsync("200 mock-nntp ready\r\n");

            var authenticatedUser = (string?)null;
            var authenticated = false;

            while (!_cts.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_cts.Token);
                if (line == null) return;
                Interlocked.Increment(ref _commandsServed);

                var parts = line.Split(' ', 3);
                var command = parts[0].ToUpperInvariant();

                switch (command)
                {
                    case "AUTHINFO" when parts.Length >= 3 && parts[1].Equals("USER", StringComparison.OrdinalIgnoreCase):
                        authenticatedUser = parts[2];
                        await writer.WriteAsync("381 Password required\r\n");
                        break;

                    case "AUTHINFO" when parts.Length >= 3 && parts[1].Equals("PASS", StringComparison.OrdinalIgnoreCase):
                        if (authenticatedUser == Username && parts[2] == Password)
                        {
                            authenticated = true;
                            await writer.WriteAsync("281 Authentication accepted\r\n");
                        }
                        else
                        {
                            await writer.WriteAsync("481 Authentication rejected\r\n");
                        }

                        break;

                    case "STAT":
                        await RespondStat(writer, parts);
                        break;

                    case "BODY":
                        await RespondBody(writer, parts, authenticated, includeHeaders: false);
                        break;

                    case "ARTICLE":
                        await RespondBody(writer, parts, authenticated, includeHeaders: true);
                        break;

                    case "HEAD":
                        await RespondHead(writer, parts);
                        break;

                    case "DATE":
                        await writer.WriteAsync("111 20260712120000\r\n");
                        break;

                    case "QUIT":
                        await writer.WriteAsync("205 bye\r\n");
                        return;

                    default:
                        await writer.WriteAsync("500 Unknown command\r\n");
                        break;
                }
            }
        }
        catch (Exception)
        {
            // client disconnected / test teardown
        }
        finally
        {
            Interlocked.Decrement(ref _currentConnections);
        }
    }

    private async Task RespondStat(StreamWriter writer, string[] parts)
    {
        var id = ExtractMessageId(parts);
        if (!RejectBodies && id != null && Articles.ContainsKey(id))
            await writer.WriteAsync($"223 0 <{id}>\r\n");
        else
            await writer.WriteAsync("430 No article with that message-id\r\n");
    }

    private async Task RespondHead(StreamWriter writer, string[] parts)
    {
        var id = ExtractMessageId(parts);
        if (id == null || !Articles.ContainsKey(id))
        {
            await writer.WriteAsync("430 No article with that message-id\r\n");
            return;
        }

        await writer.WriteAsync($"221 0 <{id}>\r\n");
        await writer.WriteAsync($"Message-ID: <{id}>\r\n");
        await writer.WriteAsync("Subject: mock article\r\n");
        for (var i = 0; i < ExtraHeadHeaders; i++)
            await writer.WriteAsync($"X-Test-{i}: value\r\n");
        await writer.WriteAsync(".\r\n");
    }

    private async Task RespondBody(StreamWriter writer, string[] parts, bool authenticated, bool includeHeaders)
    {
        if (RequireAuth && !authenticated)
        {
            await writer.WriteAsync("480 Authentication required\r\n");
            return;
        }

        var id = ExtractMessageId(parts);
        if (RejectBodies || id == null || !Articles.TryGetValue(id, out var article))
        {
            await writer.WriteAsync("430 No article with that message-id\r\n");
            return;
        }

        Interlocked.Increment(ref _bodiesServed);

        if (includeHeaders)
        {
            await writer.WriteAsync($"220 0 <{id}>\r\n");
            await writer.WriteAsync($"Message-ID: <{id}>\r\n");
            await writer.WriteAsync("Subject: mock article\r\n");
            await writer.WriteAsync("\r\n"); // header/body separator
        }
        else
        {
            await writer.WriteAsync($"222 0 <{id}>\r\n");
        }

        // BODY payloads are normally delivered by an NNTP server in network-sized
        // chunks. AutoFlush would instead turn every 128-character yEnc line into a
        // separate socket flush. Under concurrent range tests that artificial packet
        // storm can starve loopback delivery long enough to hit the client's protocol
        // timeout. Keep the already-flushed status line incremental, then buffer the
        // bounded article body and flush it once at the terminator.
        writer.AutoFlush = false;
        var lines = article.Split("\r\n");
        // a trailing CRLF produces one empty trailing element — not a body line
        var lineCount = lines.Length > 0 && lines[^1].Length == 0 ? lines.Length - 1 : lines.Length;
        foreach (var line in lines[..lineCount])
        {
            // NNTP dot-stuffing: a body line starting with '.' gets a '.' prepended
            var stuffed = line.StartsWith('.') ? "." + line : line;
            await writer.WriteAsync(stuffed + "\r\n");
        }

        await writer.WriteAsync(".\r\n");
        await writer.FlushAsync();
        writer.AutoFlush = true;
    }

    private static string? ExtractMessageId(string[] parts)
    {
        if (parts.Length < 2) return null;
        return parts[1].TrimStart('<').TrimEnd('>');
    }

    private static void InterlockedMax(ref int location, int value)
    {
        int current;
        while (value > (current = Volatile.Read(ref location)))
        {
            if (Interlocked.CompareExchange(ref location, value, current) == current)
                break;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync();
        _listener.Stop();
        Task[] clients;
        lock (_clients)
        {
            clients = _clients.ToArray();
        }

        try
        {
            await Task.WhenAll(clients).WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // best effort teardown
        }

        _cts.Dispose();
    }
}
