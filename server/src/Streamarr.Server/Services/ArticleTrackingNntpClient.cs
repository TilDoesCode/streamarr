using System.Diagnostics;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Server.Services;

internal sealed class ArticleTrackingNntpClient(
    INntpClient inner,
    ArticleDownloadTracker tracker) : NntpClientBase
{
    public override Task ConnectAsync(
        string host,
        int port,
        bool useSsl,
        CancellationToken cancellationToken)
        => inner.ConnectAsync(host, port, useSsl, cancellationToken);

    public override Task<NntpResponse> AuthenticateAsync(
        string user,
        string pass,
        CancellationToken cancellationToken)
        => inner.AuthenticateAsync(user, pass, cancellationToken);

    public override Task<NntpStatResponse> StatAsync(
        SegmentId segmentId,
        CancellationToken cancellationToken)
        => Observe(segmentId, "STAT", () => inner.StatAsync(segmentId, cancellationToken));

    public override Task<NntpHeadResponse> HeadAsync(
        SegmentId segmentId,
        CancellationToken cancellationToken)
        => Observe(segmentId, "HEAD", () => inner.HeadAsync(segmentId, cancellationToken));

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId,
        CancellationToken cancellationToken)
        => DecodedBodyAsync(segmentId, onConnectionReadyAgain: null, cancellationToken);

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken)
        => ObserveDecodedBody(
            segmentId,
            () => inner.DecodedBodyAsync(segmentId, onConnectionReadyAgain, cancellationToken));

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
        SegmentId segmentId,
        CancellationToken cancellationToken)
        => DecodedArticleAsync(segmentId, onConnectionReadyAgain: null, cancellationToken);

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken)
        => ObserveDecodedArticle(
            segmentId,
            () => inner.DecodedArticleAsync(segmentId, onConnectionReadyAgain, cancellationToken));

    public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
        => inner.DateAsync(cancellationToken);

    private async Task<NntpDecodedBodyResponse> ObserveDecodedBody(
        string segmentId,
        Func<Task<NntpDecodedBodyResponse>> command)
    {
        try
        {
            var response = await command().ConfigureAwait(false);
            return response with
            {
                Stream = ObserveBodyStream(segmentId, "BODY", response.Stream, response.ProviderAttempts),
            };
        }
        catch (Exception exception)
        {
            Record(segmentId, "BODY", NntpProviderAttemptMetadata.GetAttempts(exception));
            throw;
        }
    }

    private async Task<NntpDecodedArticleResponse> ObserveDecodedArticle(
        string segmentId,
        Func<Task<NntpDecodedArticleResponse>> command)
    {
        try
        {
            var response = await command().ConfigureAwait(false);
            return response with
            {
                Stream = ObserveBodyStream(segmentId, "ARTICLE", response.Stream, response.ProviderAttempts),
            };
        }
        catch (Exception exception)
        {
            Record(segmentId, "ARTICLE", NntpProviderAttemptMetadata.GetAttempts(exception));
            throw;
        }
    }

    private YencStream ObserveBodyStream(
        string segmentId,
        string operation,
        YencStream stream,
        IReadOnlyList<Streamarr.Usenet.Nntp.NntpProviderAttempt> attempts)
    {
        if (attempts.Count == 0)
            return stream;

        var terminal = attempts[^1];
        if (terminal.Outcome != NntpProviderAttemptOutcome.Success)
        {
            Record(segmentId, operation, attempts);
            return stream;
        }

        if (attempts.Count > 1)
            Record(segmentId, operation, attempts.Take(attempts.Count - 1).ToArray());

        var bodyStarted = Stopwatch.GetTimestamp();
        return new CompletionObservedYencStream(stream, exception =>
        {
            if (exception is OperationCanceledException)
                return;

            var durationMs = terminal.DurationMs + Stopwatch.GetElapsedTime(bodyStarted).TotalMilliseconds;
            if (exception is null)
            {
                Record(segmentId, operation, [terminal with { DurationMs = durationMs }]);
                return;
            }

            var diagnostic = exception.InnerException is null ? exception : exception.GetBaseException();
            Record(segmentId, operation, [terminal with
            {
                Outcome = NntpProviderAttemptOutcome.Error,
                DurationMs = durationMs,
                ErrorType = diagnostic.GetType().Name,
                ErrorMessage = SafeError(diagnostic),
            }]);
        });
    }

    private async Task<T> Observe<T>(
        string segmentId,
        string operation,
        Func<Task<T>> command) where T : NntpResponse
    {
        try
        {
            var response = await command().ConfigureAwait(false);
            Record(segmentId, operation, response.ProviderAttempts);
            return response;
        }
        catch (Exception exception)
        {
            Record(segmentId, operation, NntpProviderAttemptMetadata.GetAttempts(exception));
            throw;
        }
    }

    private void Record(
        string segmentId,
        string operation,
        IReadOnlyList<Streamarr.Usenet.Nntp.NntpProviderAttempt> attempts)
    {
        if (attempts.Count == 0)
            return;

        tracker.RecordProviderAttempts(
            segmentId,
            operation,
            attempts.Select(attempt => new NntpProviderAttempt(
                attempt.Provider,
                attempt.Outcome.ToString().ToLowerInvariant(),
                attempt.DurationMs,
                attempt.ResponseCode,
                attempt.ErrorType,
                attempt.ErrorMessage)).ToArray());
    }

    private static string SafeError(Exception exception)
    {
        var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return message.Length <= 512 ? message : message[..512];
    }

    public override void Dispose() => inner.Dispose();
}

internal sealed class CompletionObservedYencStream(
    YencStream inner,
    Action<Exception?> onCompleted)
    : YencStream(Stream.Null, validateCrc: false)
{
    private int _terminal;

    public override async ValueTask<YencHeader?> GetYencHeadersAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            return await inner.GetYencHeadersAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            Complete(exception);
            throw;
        }
    }

    public override async ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var read = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
                Complete(null);
            return read;
        }
        catch (Exception exception)
        {
            Complete(exception);
            throw;
        }
    }

    private void Complete(Exception? exception)
    {
        if (Interlocked.Exchange(ref _terminal, 1) != 0)
            return;
        try
        {
            onCompleted(exception);
        }
        catch
        {
            // Telemetry must never alter the article stream outcome.
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }
}
