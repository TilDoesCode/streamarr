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
    private const int MaxControlLineChars = 16 * 1024;
    private const int MaxArticleLineChars = 1024 * 1024;
    private const int MaxArticleHeaderCount = 256;
    private const int MaxArticleHeaderLineCount = 512;
    private const int MaxArticleHeaderChars = 256 * 1024;
    private const long MaxEncodedArticleBytes = 64L * 1024 * 1024;
    private const int ReadBufferChars = 8 * 1024;
    private static readonly TimeSpan MaxArticleReadDuration = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan MaxHeaderReadDuration = TimeSpan.FromSeconds(30);

    private TcpClient? _tcpClient;
    private Stream? _stream;
    private StreamReader? _reader;
    private StreamWriter? _writer;
    private AsyncSemaphore _commandLock = new(1);
    private CancellationTokenSource _cts = new();
    private volatile ExceptionDispatchInfo? _backgroundException;
    private readonly char[] _readBuffer = new char[ReadBufferChars];
    private int _readBufferOffset;
    private int _readBufferLength;
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
                await sslStream.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                {
                    TargetHost = host,
                    EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12 |
                                          System.Security.Authentication.SslProtocols.Tls13,
                    CertificateRevocationCheckMode = System.Security.Cryptography.X509Certificates.X509RevocationMode.Online,
                }, cancellationToken).ConfigureAwait(false);
                _stream = sslStream;
            }

            // Use Latin1 encoding to preserve exact byte values 0-255 for yEnc-encoded content
            _reader = new StreamReader(_stream, Encoding.Latin1);
            _writer = new StreamWriter(_stream, Encoding.Latin1) { AutoFlush = true };

            // Read the server response
            using var greetingCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
            var response = await ReadLineAsync(greetingCts.Token).ConfigureAwait(false);
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
        ValidateCommandValue(user, nameof(user));
        ValidateCommandValue(pass, nameof(pass));
        await _commandLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();
            using var commandCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);

            // Send AUTHINFO USER command
            await WriteLineAsync($"AUTHINFO USER {user}".AsMemory(), commandCts.Token).ConfigureAwait(false);
            var userResponse = await ReadLineAsync(commandCts.Token).ConfigureAwait(false);
            var userResponseCode = ParseResponseCode(userResponse);

            // Password required
            if (userResponseCode == (int)NntpResponseType.PasswordRequired)
            {
                // Send AUTHINFO PASS command
                await WriteLineAsync($"AUTHINFO PASS {pass}".AsMemory(), commandCts.Token).ConfigureAwait(false);
                var passResponse = await ReadLineAsync(commandCts.Token).ConfigureAwait(false);
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
            using var commandCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);

            // Send STAT command with message-id
            await WriteLineAsync($"STAT <{segmentId}>".AsMemory(), commandCts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(commandCts.Token).ConfigureAwait(false);
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
            using var commandCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);

            await WriteLineAsync("DATE".AsMemory(), commandCts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(commandCts.Token).ConfigureAwait(false);
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
            using var commandCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
            commandCts.CancelAfter(MaxHeaderReadDuration);

            await WriteLineAsync($"HEAD <{segmentId}>".AsMemory(), commandCts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(commandCts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            NntpArticleHeaders? headers = null;
            if (responseCode == (int)NntpResponseType.ArticleRetrievedHeadFollows)
            {
                headers = await ParseArticleHeadersAsync(readUntilTerminator: true, commandCts.Token)
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
        CancellationTokenSource? articleCts = null;

        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            articleCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
            articleCts.CancelAfter(MaxArticleReadDuration);

            // Send BODY command with message-id
            await WriteLineAsync($"BODY <{segmentId}>".AsMemory(), articleCts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(articleCts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            // Article retrieved - body follows
            if (responseCode == (int)NntpResponseType.ArticleRetrievedBodyFollows)
            {
                var pipe = CreateBodyPipe();

                // Start background task to read the body and write to pipe
                isReadBodyToPipeAsyncStarted = true;
                _ = ReadBodyToPipeAsync(pipe.Writer, articleCts.Token, result =>
                {
                    articleCts.Dispose();
                    _commandLock.Release();
                    onConnectionReadyAgain?.Invoke(result);
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
                articleCts?.Dispose();
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
        CancellationTokenSource? articleCts = null;

        try
        {
            ThrowIfUnhealthy();
            ThrowIfNotConnected();

            articleCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token, cancellationToken);
            articleCts.CancelAfter(MaxArticleReadDuration);

            // Send ARTICLE command with message-id
            await WriteLineAsync($"ARTICLE <{segmentId}>".AsMemory(), articleCts.Token).ConfigureAwait(false);
            var response = await ReadLineAsync(articleCts.Token).ConfigureAwait(false);
            var responseCode = ParseResponseCode(response);

            // Article retrieved - head and body follow
            if (responseCode == (int)NntpResponseType.ArticleRetrievedHeadAndBodyFollow)
            {
                // Parse headers (terminated by the blank separator line)
                var headers = await ParseArticleHeadersAsync(readUntilTerminator: false, articleCts.Token)
                    .ConfigureAwait(false);

                var pipe = CreateBodyPipe();

                // Start background task to read the body and write to pipe
                isReadBodyToPipeAsyncStarted = true;
                _ = ReadBodyToPipeAsync(pipe.Writer, articleCts.Token, result =>
                {
                    articleCts.Dispose();
                    _commandLock.Release();
                    onConnectionReadyAgain?.Invoke(result);
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
                articleCts?.Dispose();
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
        pauseWriterThreshold: 2 * 1024 * 1024,
        resumeWriterThreshold: 1024 * 1024,
        minimumSegmentSize: 16 * 1024,
        useSynchronizationContext: false
    ));

    private static void ValidateCommandValue(string value, string paramName)
    {
        ArgumentNullException.ThrowIfNull(value, paramName);
        if (value.Length > 4096 || value.Any(c => char.IsControl(c) || c is '\r' or '\n'))
            throw new ArgumentException("NNTP command values cannot contain control characters.", paramName);
    }

    private async Task ReadBodyToPipeAsync(
        PipeWriter writer,
        CancellationToken cancellationToken,
        Action<ArticleBodyResult> onFinally)
    {
        var articleResult = ArticleBodyResult.NotRetrieved;
        Exception? failure = null;
        try
        {
            if (_reader == null)
                throw new UsenetProtocolException("Invalid NNTP response: article stream is unavailable.");

            long encodedBytes = 0;
            var shouldWrite = true;

            // Read lines until we encounter the termination sequence (single dot on a line)
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = await ReadLineAsync(cancellationToken, MaxArticleLineChars).ConfigureAwait(false);

                if (line == null)
                    throw new UsenetProtocolException("Invalid NNTP response: article terminator is missing.");

                // Check for NNTP termination sequence (single dot)
                if (line == ".")
                {
                    articleResult = ArticleBodyResult.Retrieved;
                    break;
                }

                if (line.Length > MaxEncodedArticleBytes - encodedBytes - 2)
                    throw new UsenetProtocolException(
                        $"Invalid NNTP response: article exceeds the {MaxEncodedArticleBytes} byte limit.");
                encodedBytes += line.Length + 2;

                // A seek can intentionally dispose a partially consumed pipe. Continue
                // draining the bounded/time-limited article so this connection remains
                // protocol-synchronized and reusable, but stop buffering discarded data.
                if (!shouldWrite)
                    continue;

                WriteLineToPipe(writer, line);

                // Flush periodically to make data available for reading
                var flush = await RunWithTimeoutAsync(writer.FlushAsync, cancellationToken).ConfigureAwait(false);
                if (flush.IsCanceled)
                    throw new OperationCanceledException("The article consumer canceled reading.", cancellationToken);
                if (flush.IsCompleted)
                    shouldWrite = false;
            }
        }
        catch (Exception e)
        {
            failure = e;
            MarkConnectionUnhealthy(e);
        }
        finally
        {
            try
            {
                await writer.CompleteAsync(failure).ConfigureAwait(false);
            }
            finally
            {
                onFinally.Invoke(articleResult);
            }
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
        var headerCount = 0;
        var headerLineCount = 0;
        var totalHeaderChars = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            var line = await ReadLineAsync(cancellationToken).ConfigureAwait(false);

            if (line == null)
            {
                throw new UsenetProtocolException("Invalid NNTP response: missing article headers.");
            }

            headerLineCount++;
            if (headerLineCount > MaxArticleHeaderLineCount ||
                line.Length > MaxArticleHeaderChars - totalHeaderChars)
            {
                throw new UsenetProtocolException("Invalid NNTP response: article headers exceed the size limit.");
            }
            totalHeaderChars += line.Length;

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
                    headerCount++;
                    if (headerCount > MaxArticleHeaderCount)
                        throw new UsenetProtocolException("Invalid NNTP response: too many article headers.");

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
        _readBufferOffset = 0;
        _readBufferLength = 0;
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
            var error = new TimeoutException("Timeout writing to NNTP stream.");
            MarkConnectionUnhealthy(error);
            throw error;
        }
        catch (OperationCanceledException e)
        {
            MarkConnectionUnhealthy(e);
            throw;
        }
    }

    private async ValueTask<string?> ReadLineAsync(CancellationToken ct, int maxChars = MaxControlLineChars)
    {
        using var cts = CreateCtsWithTimeout(ct);
        try
        {
            return await ReadBoundedLineCoreAsync(maxChars, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cts.Token.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            var error = new TimeoutException("Timeout reading from NNTP stream.");
            MarkConnectionUnhealthy(error);
            throw error;
        }
        catch (OperationCanceledException e)
        {
            MarkConnectionUnhealthy(e);
            throw;
        }
        catch (UsenetProtocolException e)
        {
            MarkConnectionUnhealthy(e);
            throw;
        }
    }

    private void MarkConnectionUnhealthy(Exception error)
    {
        lock (this)
        {
            _backgroundException = ExceptionDispatchInfo.Capture(error);
        }

        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Connection teardown won the race.
        }

        _tcpClient?.Dispose();
    }

    /// <summary>
    /// Reads through a fixed-size intermediate buffer so an untrusted peer cannot make
    /// <see cref="StreamReader.ReadLineAsync(CancellationToken)"/> grow an unbounded string.
    /// Data following a newline remains in the buffer for the next protocol read.
    /// </summary>
    private async ValueTask<string?> ReadBoundedLineCoreAsync(int maxChars, CancellationToken ct)
    {
        StringBuilder? builder = null;

        while (true)
        {
            if (_readBufferOffset >= _readBufferLength)
            {
                _readBufferLength = await _reader!.ReadAsync(_readBuffer.AsMemory(), ct).ConfigureAwait(false);
                _readBufferOffset = 0;
                if (_readBufferLength == 0)
                {
                    if (builder is null)
                        return null;
                    return RemoveTrailingCarriageReturn(builder.ToString());
                }
            }

            var chunkStart = _readBufferOffset;
            var newline = Array.IndexOf(
                _readBuffer,
                '\n',
                chunkStart,
                _readBufferLength - chunkStart);
            var chunkLength = newline >= 0 ? newline - chunkStart : _readBufferLength - chunkStart;
            var accumulated = builder?.Length ?? 0;
            if (chunkLength > maxChars - accumulated)
                throw new UsenetProtocolException($"Invalid NNTP response: line exceeds the {maxChars} character limit.");

            if (newline >= 0)
            {
                _readBufferOffset = newline + 1;
                if (builder is null)
                    return RemoveTrailingCarriageReturn(new string(_readBuffer, chunkStart, chunkLength));

                builder.Append(_readBuffer, chunkStart, chunkLength);
                return RemoveTrailingCarriageReturn(builder.ToString());
            }

            builder ??= new StringBuilder(Math.Min(maxChars, Math.Max(ReadBufferChars, chunkLength * 2)));
            builder.Append(_readBuffer, chunkStart, chunkLength);
            _readBufferOffset = _readBufferLength;
        }
    }

    private static string RemoveTrailingCarriageReturn(string value)
        => value.EndsWith('\r') ? value[..^1] : value;

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
