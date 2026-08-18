// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/MultiProviderNntpClient.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr
// (Serilog -> ILogger; provider priority added to ordering; renamed types).

using System.Diagnostics;
using System.Runtime.ExceptionServices;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Nntp.Pooling;

/// <summary>
/// Fans NNTP commands out over a priority-ordered list of providers.
/// When an article is missing (430) or a provider fails, the next provider is
/// tried, so a block/backup account transparently backfills the primary
/// (DECISIONS.md #6: the pool is written against a provider list from the start).
/// </summary>
public class MultiProviderNntpClient : NntpClientBase
{
    private readonly ILogger _logger;
    private MultiConnectionNntpClient[] _providers;

    public MultiProviderNntpClient(List<MultiConnectionNntpClient> providers, ILogger? logger = null)
    {
        ArgumentNullException.ThrowIfNull(providers);
        _providers = [.. providers];
        _logger = logger ?? NullLogger.Instance;
    }

    public IReadOnlyList<MultiConnectionNntpClient> Providers => Volatile.Read(ref _providers);

    /// <summary>
    /// Atomically replaces the provider snapshot. Existing borrowed connections may
    /// finish; idle connections and later returns from the retired pools are disposed.
    /// New commands immediately use the replacement list.
    /// </summary>
    public void ReplaceProviders(List<MultiConnectionNntpClient> providers)
    {
        ArgumentNullException.ThrowIfNull(providers);
        var retired = Interlocked.Exchange(ref _providers, [.. providers]);
        foreach (var provider in retired)
            provider.Dispose();
    }

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken ct)
    {
        throw new NotSupportedException("Please connect within the connectionFactory");
    }

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken ct)
    {
        throw new NotSupportedException("Please authenticate within the connectionFactory");
    }

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        return RunFromPoolWithBackup("STAT", x => x.StatAsync(segmentId, cancellationToken), cancellationToken);
    }

    public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        return RunFromPoolWithBackup("HEAD", x => x.HeadAsync(segmentId, cancellationToken), cancellationToken);
    }

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        CancellationToken cancellationToken
    )
    {
        return RunFromPoolWithBackup("BODY", x => x.DecodedBodyAsync(segmentId, cancellationToken), cancellationToken);
    }

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        CancellationToken cancellationToken
    )
    {
        return RunFromPoolWithBackup(
            "ARTICLE",
            x => x.DecodedArticleAsync(segmentId, cancellationToken),
            cancellationToken);
    }

    public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
    {
        return RunFromPoolWithBackup("DATE", x => x.DateAsync(cancellationToken), cancellationToken);
    }

    public override async Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        NntpDecodedBodyResponse result;
        try
        {
            result = await RunFromPoolWithBackup(
                "BODY",
                x => x.DecodedBodyAsync(segmentId, OnConnectionReadyAgain, cancellationToken),
                cancellationToken
            ).ConfigureAwait(false);
        }
        catch
        {
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            throw;
        }

        if (result.ResponseType != NntpResponseType.ArticleRetrievedBodyFollows)
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);

        return result;

        void OnConnectionReadyAgain(ArticleBodyResult articleBodyResult)
        {
            onConnectionReadyAgain?.Invoke(articleBodyResult);
        }
    }

    public override async Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        NntpDecodedArticleResponse result;
        try
        {
            result = await RunFromPoolWithBackup(
                "ARTICLE",
                x => x.DecodedArticleAsync(segmentId, OnConnectionReadyAgain, cancellationToken),
                cancellationToken
            ).ConfigureAwait(false);
        }
        catch
        {
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);
            throw;
        }

        if (result.ResponseType != NntpResponseType.ArticleRetrievedHeadAndBodyFollow)
            onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved);

        return result;

        void OnConnectionReadyAgain(ArticleBodyResult articleBodyResult)
        {
            onConnectionReadyAgain?.Invoke(articleBodyResult);
        }
    }

    private async Task<T> RunFromPoolWithBackup<T>
    (
        string operation,
        Func<INntpClient, Task<T>> task,
        CancellationToken cancellationToken
    ) where T : NntpResponse
    {
        ExceptionDispatchInfo? lastException = null;
        var attempts = new List<NntpProviderAttempt>();
        var orderedProviders = GetOrderedProviders();
        try
        {
            for (var i = 0; i < orderedProviders.Count; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var provider = orderedProviders[i];
                var isLastProvider = i == orderedProviders.Count - 1;

                if (lastException is not null)
                {
                    _logger.LogDebug(
                        "Encountered error during NNTP Operation: `{Message}`. Trying another provider.",
                        lastException.SourceException.Message);
                }

                var stopwatch = Stopwatch.StartNew();
                try
                {
                    var result = await task.Invoke(provider).ConfigureAwait(false);
                    stopwatch.Stop();

                    var missing = result.ResponseType == NntpResponseType.NoArticleWithThatMessageId;
                    var outcome = missing
                        ? NntpProviderAttemptOutcome.Missing
                        : result.Success
                            ? NntpProviderAttemptOutcome.Success
                            : NntpProviderAttemptOutcome.Rejected;
                    attempts.Add(new NntpProviderAttempt(
                        provider.ProviderName,
                        operation,
                        outcome,
                        stopwatch.Elapsed.TotalMilliseconds,
                        result.ResponseCode,
                        ErrorMessage: outcome == NntpProviderAttemptOutcome.Success
                            ? null
                            : NntpProviderAttemptMetadata.NormalizeErrorMessage(result.ResponseMessage)));

                    // if no article with that message-id is found, try again with the next provider.
                    if (!isLastProvider && missing)
                        continue;

                    result.ProviderAttempts.AddRange(attempts);
                    return result;
                }
                catch (Exception e) when (!SingleConnectionNntpClient.IsCancellation(e))
                {
                    stopwatch.Stop();
                    attempts.Add(NntpProviderAttemptMetadata.FromException(
                        provider.ProviderName,
                        operation,
                        stopwatch.Elapsed.TotalMilliseconds,
                        e));
                    lastException = ExceptionDispatchInfo.Capture(e);
                }
            }
        }
        catch (Exception e) when (SingleConnectionNntpClient.IsCancellation(e))
        {
            NntpProviderAttemptMetadata.SetAttempts(e, attempts);
            throw;
        }

        if (lastException is not null)
        {
            NntpProviderAttemptMetadata.SetAttempts(lastException.SourceException, attempts);
            lastException.Throw();
        }

        var noProviders = new InvalidOperationException("There are no usenet providers configured.");
        NntpProviderAttemptMetadata.SetAttempts(noProviders, attempts);
        throw noProviders;
    }

    private List<MultiConnectionNntpClient> GetOrderedProviders()
    {
        var enabled = Providers
            .Where(x => x.ProviderType != UsenetProviderType.Disabled)
            .OrderBy(x => x.Priority)
            .ThenBy(x => x.ProviderType)
            .ThenByDescending(x => x.AvailableConnections)
            .ToList();

        var healthy = enabled.Where(x => !x.IsTripped).ToList();

        // Always return at least one provider so cooldown probes can fire.
        return healthy.Count > 0 ? healthy : enabled;
    }

    public override void Dispose()
    {
        var retired = Interlocked.Exchange(ref _providers, []);
        foreach (var provider in retired)
            provider.Dispose();
        GC.SuppressFinalize(this);
    }
}
