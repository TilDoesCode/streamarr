// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Clients/UsenetClient*.cs (partial classes, merged)
//         @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr:
// renamed UsenetClient -> NntpConnection, response models renamed, net8 target.

using System.IO.Pipelines;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Text;
using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Nntp;

/// <summary>
/// A single NNTP connection: TCP (+ optional TLS), AUTHINFO USER/PASS
/// authentication, and STAT / HEAD / BODY / ARTICLE / DATE commands.
/// BODY and ARTICLE stream the (dot-unstuffed) article body through a pipe and
/// release the connection for the next command once the body fully arrived.
/// </summary>
public sealed class NntpConnection : IDisposable
{
    private TcpClient? _tcpClient;
    private Stream? _stream;
    private StreamReader? _reader;
    private StreamWriter? _writer;
    private AsyncSemaphore _commandLock = new(1);
    private CancellationTokenSource _cts = new();
    private volatile ExceptionDispatchInfo? _backgroundException;
    private bool _disposed;

    public async Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
    {
        // Clean up any existing connection
        CleanupConnection();
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _tcpClient = new TcpClient();
            await _tcpClient.ConnectAsync(host, port, cancellationToken).ConfigureAwait(false);
            _stream = _tcpClient.GetStream();

            if (useSsl)
            {
                var sslStream = new SslStream(_stream, false);
                await sslStream.AuthenticateAsClientAsync(host, null,
                    System.Security.Authentication.SslProtocols.Tls12 |
                    System.Security.Authentication.SslProtocols.Tls13, true).ConfigureAwait(false);
                _stream = sslStream;
            }

            // Use Latin1 encoding to preserve exact byte values 0-255 for yEnc-encoded content
            _reader = new StreamReader(_stream, Encoding.Latin1);
            _writer = new StreamWriter(_stream, Encoding.Latin1) { AutoFlush = true };

            // Read the server response
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            // NNTP servers typically respond with "200" or "201" for successful connection
            if (responseCode != (int)NntpResponseType.ServerReadyPostingAllowed &&
                responseCode != (int)NntpResponseType.ServerReadyNoPostingAllowed)
                throw new UsenetConnectionException(response!) { ResponseCode = responseCode };
        }
        finally
        {
            _commandLock.Release();
        }
    }

    public async Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken)
    {
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            // Send AUTHINFO USER command
            await WriteLineAsync($"AUTHINFO USER {user}".AsMemory(), _cts.Token).ConfigureAwait(false);
            var userResponse = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var userResponseCode = ParseResponseCode(userResponse);

            // Password required
            if (userResponseCode == (int)NntpResponseType.PasswordRequired)
            {
                // Send AUTHINFO PASS command
                await WriteLineAsync($"AUTHINFO PASS {pass}".AsMemory(), _cts.Token).ConfigureAwait(false);
                var passResponse = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
                var passResponseCode = ParseResponseCode(passResponse);

                return new NntpResponse
                {
                    ResponseCode = passResponseCode,
                    ResponseMessage = passResponse!,
                };
            }

            return new NntpResponse
            {
                ResponseCode = userResponseCode,
                ResponseMessage = userResponse!,
            };
        }
        finally
        {
            _commandLock.Release();
        }
    }

    public async Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            // Send STAT command with message-id
            await WriteLineAsync($"STAT <{segmentId}>".AsMemory(), _cts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            return new NntpStatResponse
            {
                ResponseCode = responseCode,
                ResponseMessage = response!,
                ArticleExists = responseCode == (int)NntpResponseType.ArticleExists,
            };
        }
        finally
        {
            _commandLock.Release();
        }
    }

    public async Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
    {
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            await WriteLineAsync("DATE".AsMemory(), _cts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            var dateTime = responseCode == (int)NntpResponseType.DateAndTime
                ? ParseDateResponse(response!)
                : null;

            return new NntpDateResponse
            {
                ResponseCode = responseCode,
                ResponseMessage = response!,
                DateTime = dateTime,
            };
        }
        finally
        {
            _commandLock.Release();
        }
    }

    public async Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            await WriteLineAsync($"HEAD <{segmentId}>".AsMemory(), _cts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            NntpArticleHeaders? headers = null;
            if (responseCode == (int)NntpResponseType.ArticleRetrievedHeadFollows)
            {
                headers = await ParseArticleHeadersAsync(readUntilTerminator: true, _cts.Token)
                    .ConfigureAwait(false);
            }

            return new NntpHeadResponse
            {
                SegmentId = segmentId,
                ResponseCode = responseCode,
                ResponseMessage = response!,
                ArticleHeaders = headers,
            };
        }
        finally
        {
            _commandLock.Release();
        }
    }

    public Task<NntpBodyResponse> BodyAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        return BodyAsync(segmentId, null, cancellationToken);
    }

    public async Task<NntpBodyResponse> BodyAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        try
        {
            await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            throw;
        }

        var isReadBodyToPipeAsyncStarted = false;

        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            // Send BODY command with message-id
            await WriteLineAsync($"BODY <{segmentId}>".AsMemory(), _cts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            // Article retrieved - body follows
            if (responseCode == (int)NntpResponseType.ArticleRetrievedBodyFollows)
            {
                var pipe = CreateBodyPipe();

                // Start background task to read the body and write to pipe
                isReadBodyToPipeAsyncStarted = true;
                _ = ReadBodyToPipeAsync(pipe.Writer, _cts.Token, () =>
                {
                    pipe.Writer.Complete();
                    _commandLock.Release();
                    onConnectionReadyAgain?.Invoke(ArticleBodyResult.Retrieved);
                });

                // Return immediately with the stream
                return new NntpBodyResponse
                {
                    SegmentId = segmentId,
                    ResponseCode = responseCode,
                    ResponseMessage = response!,
                    Stream = pipe.Reader.AsStream(),
                };
            }

            return new NntpBodyResponse
            {
                ResponseCode = responseCode,
                ResponseMessage = response!,
                SegmentId = segmentId,
                Stream = null
            };
        }
        finally
        {
            if (!isReadBodyToPipeAsyncStarted)
            {
                _commandLock.Release();
                onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            }
        }
    }

    public Task<NntpArticleResponse> ArticleAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        return ArticleAsync(segmentId, null, cancellationToken);
    }

    public async Task<NntpArticleResponse> ArticleAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        try
        {
            await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            throw;
        }

        var isReadBodyToPipeAsyncStarted = false;

        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            // Send ARTICLE command with message-id
            await WriteLineAsync($"ARTICLE <{segmentId}>".AsMemory(), _cts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(_cts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            // Article retrieved - head and body follow
            if (responseCode == (int)NntpResponseType.ArticleRetrievedHeadAndBodyFollow)
            {
                // Parse headers (terminated by the blank separator line)
                var headers = await ParseArticleHeadersAsync(readUntilTerminator: false, _cts.Token)
                    .ConfigureAwait(false);

                var pipe = CreateBodyPipe();

                // Start background task to read the body and write to pipe
                isReadBodyToPipeAsyncStarted = true;
                _ = ReadBodyToPipeAsync(pipe.Writer, _cts.Token, () =>
                {
                    pipe.Writer.Complete();
                    _commandLock.Release();
                    onConnectionReadyAgain?.Invoke(ArticleBodyResult.Retrieved);
                });

                return new NntpArticleResponse
                {
                    SegmentId = segmentId,
                    ResponseCode = responseCode,
                    ResponseMessage = response!,
                    ArticleHeaders = headers,
                    Stream = pipe.Reader.AsStream(),
                };
            }

            return new NntpArticleResponse
            {
                ResponseCode = responseCode,
                ResponseMessage = response!,
                SegmentId = segmentId,
                Stream = null,
                ArticleHeaders = null
            };
        }
        finally
        {
            if (!isReadBodyToPipeAsyncStarted)
            {
                _commandLock.Release();
                onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            }
        }
    }

    public async Task WaitForReadyAsync(CancellationToken cancellationToken = default)
    {
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        _commandLock.Release();
    }

    /* ----------------------------- helpers ----------------------------- */

    private static DateTimeOffset? ParseDateResponse(string response)
    {
        if (response.Length < 4 + 14) return null;
        var timestamp = response.AsSpan(4, 14);
        if (DateTime.TryParseExact(timestamp, "yyyyMMddHHmmss", null,
                System.Globalization.DateTimeStyles.AssumeUniversal |
                System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsed))
        {
            return new DateTimeOffset(parsed, TimeSpan.Zero);
        }

        return null;
    }

    private static Pipe CreateBodyPipe() => new(new PipeOptions(
        pauseWriterThreshold: long.MaxValue,
        resumeWriterThreshold: long.MaxValue - 1
    ));

    private async Task ReadBodyToPipeAsync(PipeWriter writer, CancellationToken cancellationToken, Action onFinally)
    {
        try
        {
            if (_reader == null)
            {
                await writer.CompleteAsync().ConfigureAwait(false);
                return;
            }

            var shouldWrite = true;

            // Read lines until we encounter the termination sequence (single dot on a line)
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await ReadLineAsync(cancellationToken).ConfigureAwait(false);

                if (line == null)
                {
                    // End of stream
                    break;
                }

                // Check for NNTP termination sequence (single dot)
                if (line == ".")
                {
                    break;
                }

                if (!shouldWrite) continue;

                WriteLineToPipe(writer, line);

                // Flush periodically to make data available for reading
                var result = await RunWithTimeoutAsync(writer.FlushAsync, cancellationToken).ConfigureAwait(false);
                if (result.IsCompleted || result.IsCanceled)
                {
                    shouldWrite = false;
                }
            }
        }
        catch (Exception e)
        {
            lock (this)
            {
                _backgroundException = ExceptionDispatchInfo.Capture(e);
            }
        }
        finally
        {
            onFinally.Invoke();
        }
    }

    private static void WriteLineToPipe(PipeWriter writer, string line)
    {
        // NNTP escaping: Lines starting with ".." should have the first dot removed
        var lineSpan = line.AsSpan();
        if (lineSpan.Length >= 2 && lineSpan[0] == '.' && lineSpan[1] == '.')
        {
            lineSpan = lineSpan[1..];
        }

        // Write the line to the pipe using Latin1 to preserve byte values 0-255
        var byteCount = Encoding.Latin1.GetByteCount(lineSpan) + 2; // +2 for CRLF
        var span = writer.GetSpan(byteCount);
        var written = Encoding.Latin1.GetBytes(lineSpan, span);
        span[written++] = (byte)'\r';
        span[written++] = (byte)'\n';
        writer.Advance(written);
    }

    private async Task<NntpArticleHeaders> ParseArticleHeadersAsync
    (
        bool readUntilTerminator,
        CancellationToken cancellationToken
    )
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? currentHeaderName = null;
        var currentHeaderValue = new StringBuilder();

        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await ReadLineAsync(cancellationToken).ConfigureAwait(false);

            if (line == null)
            {
                throw new UsenetProtocolException("Invalid NNTP response: missing article headers.");
            }

            // Empty line (ARTICLE separator) or "." (HEAD terminator) signals end of headers
            if (string.IsNullOrEmpty(line) || line == ".")
            {
                // Save the last header if any
                if (currentHeaderName != null)
                {
                    headers[currentHeaderName] = currentHeaderValue.ToString().Trim();
                }

                if (readUntilTerminator && line != ".")
                    continue;

                break;
            }

            // Check if this is a continuation line (starts with whitespace)
            if (line[0] == ' ' || line[0] == '\t')
            {
                // Append to current header value
                if (currentHeaderName != null)
                {
                    currentHeaderValue.Append(' ');
                    currentHeaderValue.Append(line.Trim());
                }
            }
            else
            {
                // Save the previous header if any
                if (currentHeaderName != null)
                {
                    headers[currentHeaderName] = currentHeaderValue.ToString().Trim();
                }

                // Parse new header: "Name: Value"
                var colonIndex = line.IndexOf(':');
                if (colonIndex > 0)
                {
                    currentHeaderName = line[..colonIndex].Trim();
                    currentHeaderValue.Clear();

                    // Get value after colon
                    if (colonIndex + 1 < line.Length)
                    {
                        currentHeaderValue.Append(line[(colonIndex + 1)..].Trim());
                    }
                }
            }
        }

        return new NntpArticleHeaders { Headers = headers };
    }

    private void CleanupConnection()
    {
        _reader?.Dispose();
        _writer?.Dispose();
        _stream?.Dispose();
        _tcpClient?.Dispose();
        _commandLock.Dispose();
        _cts.Dispose();

        _reader = null;
        _writer = null;
        _stream = null;
        _tcpClient = null;
        _commandLock = new AsyncSemaphore(1);
        _cts = new CancellationTokenSource();
        lock (this)
        {
            _backgroundException = null;
        }
    }

    private static int ParseResponseCode(string? response)
    {
        if (string.IsNullOrEmpty(response) || response.Length < 3)
        {
            throw new UsenetProtocolException($"Invalid NNTP Response: {response}");
        }

        if (int.TryParse(response.AsSpan(0, 3), out var code))
        {
            return code;
        }

        throw new UsenetProtocolException($"Invalid NNTP Response: {response}");
    }

    private void ThrowIfNotConnected()
    {
        if (_writer == null || _reader == null || _tcpClient == null || !_tcpClient.Connected)
        {
            throw new UsenetNotConnectedException("Not connected to server. Call ConnectAsync first.");
        }
    }

    private void ThrowIfUnhealthy()
    {
        lock (this)
        {
            _backgroundException?.Throw();
        }
    }

    private static CancellationTokenSource CreateCtsWithTimeout(CancellationToken cancellationToken)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(10));
        return cts;
    }

    private async Task WriteLineAsync(ReadOnlyMemory<char> line, CancellationToken ct)
    {
        using var cts = CreateCtsWithTimeout(ct);
        try
        {
            await _writer!.WriteLineAsync(line, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cts.Token.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new TimeoutException("Timeout writing to NNTP stream.");
        }
    }

    private async ValueTask<string?> ReadLineAsync(CancellationToken ct)
    {
        using var cts = CreateCtsWithTimeout(ct);
        try
        {
            return await _reader!.ReadLineAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cts.Token.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new TimeoutException("Timeout reading from NNTP stream.");
        }
    }

    private async ValueTask<T> RunWithTimeoutAsync<T>(Func<CancellationToken, ValueTask<T>> func, CancellationToken ct)
    {
        using var cts = CreateCtsWithTimeout(ct);
        try
        {
            return await func(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cts.Token.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new TimeoutException("Timeout encountered within NNTP stream.");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        CleanupConnection();
        _disposed = true;
    }
}
