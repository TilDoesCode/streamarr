using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Streamarr.Tests.Shared;

/// <summary>
/// In-repo mock NNTP server (DECISIONS.md: all integration tests run against
/// this until real provider credentials exist). Speaks the subset of NNTP that
/// Streamarr uses: greeting, AUTHINFO USER/PASS, GROUP, OVER/XOVER, STAT, HEAD,
/// BODY, ARTICLE, DATE, QUIT — including dot-stuffing of body lines.
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

    /// <summary>Optional artificial latency applied before every command response (network RTT simulation).</summary>
    public TimeSpan CommandLatency { get; init; } = TimeSpan.Zero;

    /// <summary>
    /// When set, a connection receiving no command for this long is closed silently —
    /// exactly how commercial NNTP providers drop idle connections. The client only
    /// notices on its next command (EOF), which is the staleness scenario the pool's
    /// revalidation exists for.
    /// </summary>
    public TimeSpan? IdleDisconnectAfter { get; init; }

    /// <summary>Optional per-connection body throughput cap in bytes/second (0 = unlimited).</summary>
    public int BodyBytesPerSecond { get; init; }

    /// <summary>Invoked with the message-id for every served BODY/ARTICLE (duplicate tracking).</summary>
    public Action<string>? OnBodyServed { get; init; }

    /// <summary>Additional synthetic headers emitted by HEAD, for parser-bound tests.</summary>
    public int ExtraHeadHeaders { get; init; }

    /// <summary>message-id (no brackets) → raw yEnc article text (CRLF lines, not dot-stuffed).</summary>
    public ConcurrentDictionary<string, string> Articles { get; } = new();
    public ConcurrentDictionary<string, byte> StatOnlyArticles { get; } = new();

    /// <summary>
    /// Per-message-id BODY script: called with the 1-based BODY attempt count and returns
    /// the behavior for that call. Overrides the default article lookup when present.
    /// </summary>
    public ConcurrentDictionary<string, Func<int, MockBodyBehavior>> BodyScripts { get; } = new();

    /// <summary>
    /// Per-message-id STAT script: called with the 1-based STAT attempt count; returns
    /// whether STAT reports the article as present. Overrides the default lookup.
    /// </summary>
    public ConcurrentDictionary<string, Func<int, bool>> StatScripts { get; } = new();

    /// <summary>Optional per-message-id gate awaited before a BODY answer (deterministic delays).</summary>
    public ConcurrentDictionary<string, TaskCompletionSource> BodyGates { get; } = new();

    private readonly ConcurrentDictionary<string, int> _bodyCalls = new();
    private readonly ConcurrentDictionary<string, int> _statCalls = new();

    /// <summary>BODY attempts observed for one message-id (scripted or not).</summary>
    public int BodyCallCount(string messageId) => _bodyCalls.GetValueOrDefault(messageId);

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
            var selectedGroup = (string?)null;

            while (!_cts.IsCancellationRequested)
            {
                string? line;
                if (IdleDisconnectAfter is { } idleCutoff)
                {
                    try
                    {
                        line = await reader.ReadLineAsync(_cts.Token).AsTask()
                            .WaitAsync(idleCutoff, _cts.Token);
                    }
                    catch (TimeoutException)
                    {
                        return; // silent provider-side idle disconnect
                    }
                }
                else
                {
                    line = await reader.ReadLineAsync(_cts.Token);
                }

                if (line == null) return;
                Interlocked.Increment(ref _commandsServed);

                var parts = line.Split(' ', 3);
                var command = parts[0].ToUpperInvariant();

                if (CommandLatency > TimeSpan.Zero)
                    await Task.Delay(CommandLatency, _cts.Token);

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

                    case "GROUP":
                        if (parts.Length < 2)
                        {
                            await writer.WriteAsync("501 Group name required\r\n");
                            break;
                        }

                        selectedGroup = parts[1];
                        var articleCount = Articles.Count;
                        var low = articleCount > 0 ? 1 : 0;
                        await writer.WriteAsync($"211 {articleCount} {low} {articleCount} {selectedGroup}\r\n");
                        break;

                    case "OVER":
                    case "XOVER":
                        if (selectedGroup is null)
                        {
                            await writer.WriteAsync("412 No group selected\r\n");
                            break;
                        }

                        await RespondOverview(writer);
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
        if (id != null && StatScripts.TryGetValue(id, out var script))
        {
            var call = _statCalls.AddOrUpdate(id, 1, (_, v) => v + 1);
            await writer.WriteAsync(script(call)
                ? $"223 0 <{id}>\r\n"
                : "430 No article with that message-id\r\n");
            return;
        }
        if (!RejectBodies && id != null && (Articles.ContainsKey(id) || StatOnlyArticles.ContainsKey(id)))
            await writer.WriteAsync($"223 0 <{id}>\r\n");
        else
            await writer.WriteAsync("430 No article with that message-id\r\n");
    }

    private async Task RespondOverview(StreamWriter writer)
    {
        await writer.WriteAsync("224 Overview information follows\r\n");
        var articleNumber = 0;
        foreach (var article in Articles.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            articleNumber++;
            var bytes = Encoding.Latin1.GetByteCount(article.Value);
            await writer.WriteAsync(
                $"{articleNumber}\tmock article\tmock@test\tFri, 17 Jul 2026 12:00:00 +0000\t" +
                $"<{article.Key}>\t\t{bytes}\t1\r\n");
        }

        await writer.WriteAsync(".\r\n");
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
        var behavior = MockBodyBehavior.Serve;
        if (id != null)
        {
            var call = _bodyCalls.AddOrUpdate(id, 1, (_, v) => v + 1);
            if (BodyScripts.TryGetValue(id, out var script))
                behavior = script(call);
            if (BodyGates.TryGetValue(id, out var gate))
                await gate.Task.WaitAsync(_cts.Token);
        }

        if (behavior == MockBodyBehavior.Disconnect)
            throw new IOException("scripted mock disconnect");

        string? article = null;
        var present = id != null && Articles.TryGetValue(id, out article);
        if (RejectBodies || behavior == MockBodyBehavior.Missing || id == null || !present)
        {
            await writer.WriteAsync("430 No article with that message-id\r\n");
            return;
        }

        if (behavior is MockBodyBehavior.Corrupt or MockBodyBehavior.Truncate)
            article = MutateArticle(article!, behavior);

        Interlocked.Increment(ref _bodiesServed);
        OnBodyServed?.Invoke(id);

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
        var lines = article!.Split("\r\n");
        // a trailing CRLF produces one empty trailing element — not a body line
        var lineCount = lines.Length > 0 && lines[^1].Length == 0 ? lines.Length - 1 : lines.Length;
        var throttleBytes = 0;
        var throttleStart = BodyBytesPerSecond > 0 ? System.Diagnostics.Stopwatch.StartNew() : null;
        foreach (var line in lines[..lineCount])
        {
            // NNTP dot-stuffing: a body line starting with '.' gets a '.' prepended
            var stuffed = line.StartsWith('.') ? "." + line : line;
            await writer.WriteAsync(stuffed + "\r\n");

            if (throttleStart is not null)
            {
                throttleBytes += stuffed.Length + 2;
                if (throttleBytes >= 32 * 1024)
                {
                    await writer.FlushAsync();
                    var expected = TimeSpan.FromSeconds((double)throttleBytes / BodyBytesPerSecond);
                    var ahead = expected - throttleStart.Elapsed;
                    if (ahead > TimeSpan.Zero)
                        await Task.Delay(ahead, _cts.Token);
                }
            }
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

    /// <summary>Applies a scripted mutation to a raw yEnc article (corrupt payload / truncated body).</summary>
    private static string MutateArticle(string article, MockBodyBehavior behavior)
    {
        var lines = article.Split("\r\n").ToList();
        if (behavior == MockBodyBehavior.Truncate)
        {
            // Drop the second half of the payload including the =yend trailer: the decoded
            // size check then fails exactly like a really cut-off article.
            var keep = Math.Max(2, lines.Count / 2);
            return string.Join("\r\n", lines.Take(keep)) + "\r\n";
        }

        // Corrupt: flip characters on a payload line (never a =y* control line).
        for (var i = 0; i < lines.Count; i++)
        {
            if (lines[i].Length < 8 || lines[i].StartsWith("=y", StringComparison.Ordinal))
                continue;
            var chars = lines[i].ToCharArray();
            for (var k = 2; k < Math.Min(10, chars.Length - 2); k++)
                chars[k] = chars[k] == 'A' ? 'B' : 'A';
            lines[i] = new string(chars);
            break;
        }
        return string.Join("\r\n", lines);
    }
}

/// <summary>Scripted per-call BODY behavior for one message-id.</summary>
public enum MockBodyBehavior
{
    Serve,
    Missing,
    Corrupt,
    Truncate,
    Disconnect,
}
