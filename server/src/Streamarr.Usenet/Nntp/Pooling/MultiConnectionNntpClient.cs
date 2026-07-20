// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/MultiConnectionNntpClient.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr
// (Serilog -> ILogger; priority ordering added; renamed types).

using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Usenet.Concurrency;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Nntp.Pooling;

/// <summary>
/// This client is responsible for delegating NNTP commands to a connection pool.
///   * The connection pool enforces a maximum number of allowed connections
///   * When a connection is available, the NNTP command executes immediately
///   * When a connection is not available, the NNTP command waits until a connection becomes available.
///   * When multiple commands are awaiting a connection,
///     then BODY/ARTICLE commands have higher priority than STAT/HEAD/DATE commands.
/// </summary>
[SuppressMessage("ReSharper", "AccessToDisposedClosure")]
public class MultiConnectionNntpClient(
    ConnectionPool<INntpClient> connectionPool,
    UsenetProviderType type,
    ProviderCircuitBreaker circuitBreaker,
    string providerName,
    int priority = 0,
    ILogger? logger = null
) : NntpClientBase
{
    private readonly ILogger _logger = logger ?? NullLogger.Instance;

    public UsenetProviderType ProviderType { get; } = type;
    public string ProviderName { get; } = providerName;
    public int Priority { get; } = priority;
    public bool IsTripped => circuitBreaker.IsTripped;
    public int LiveConnections => connectionPool.LiveConnections;
    public int IdleConnections => connectionPool.IdleConnections;
    public int ActiveConnections => connectionPool.ActiveConnections;
    public int AvailableConnections => connectionPool.AvailableConnections;

    public Task WarmAsync(int count, CancellationToken ct = default)
        => connectionPool.WarmAsync(count, ct);

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
    {
        throw new NotSupportedException("Please connect within the connectionFactory");
    }

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass,
        CancellationToken cancellationToken)
    {
        throw new NotSupportedException("Please authenticate within the connectionFactory");
    }

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken ct)
    {
        return RunWithConnection(
            "STAT",
            SemaphorePriority.Low,
            (connection, _) => connection.StatAsync(segmentId, ct),
            onConnectionReadyAgain: null,
            ct
        );
    }

    public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken ct)
    {
        return RunWithConnection(
            "HEAD",
            SemaphorePriority.Low,
            (connection, _) => connection.HeadAsync(segmentId, ct),
            onConnectionReadyAgain: null,
            ct
        );
    }

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, CancellationToken ct)
    {
        return RunWithConnection(
            "BODY",
            SemaphorePriority.High,
            (connection, onDone) => connection.DecodedBodyAsync(segmentId, onDone, ct),
            onConnectionReadyAgain: null,
            ct
        );
    }

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        CancellationToken ct
    )
    {
        return RunWithConnection(
            "ARTICLE",
            SemaphorePriority.High,
            (connection, onDone) => connection.DecodedArticleAsync(segmentId, onDone, ct),
            onConnectionReadyAgain: null,
            ct
        );
    }

    public override Task<NntpDateResponse> DateAsync(CancellationToken ct)
    {
        return RunWithConnection(
            "DATE",
            SemaphorePriority.Low,
            (connection, _) => connection.DateAsync(ct),
            onConnectionReadyAgain: null,
            ct
        );
    }

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken ct
    )
    {
        return RunWithConnection(
            "BODY",
            SemaphorePriority.High,
            (connection, onDone) => connection.DecodedBodyAsync(segmentId, onDone, ct),
            onConnectionReadyAgain,
            ct
        );
    }

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken ct
    )
    {
        return RunWithConnection(
            "ARTICLE",
            SemaphorePriority.High,
            (connection, onDone) => connection.DecodedArticleAsync(segmentId, onDone, ct),
            onConnectionReadyAgain,
            ct
        );
    }

    private async Task<T> RunWithConnection<T>
    (
        string name,
        SemaphorePriority priority,
        Func<INntpClient, Action<ArticleBodyResult>, Task<T>> command,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken ct,
        int retryCount = 1
    ) where T : NntpResponse
    {
        while (retryCount >= 0)
        {
            ConnectionLock<INntpClient>? connectionLock = null;
            try
            {
                connectionLock = await connectionPool.GetConnectionLockAsync(priority, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (SingleConnectionNntpClient.IsCancellation(e))
            {
                Quietly(() => connectionLock?.Dispose());
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
                throw;
            }
            catch (Exception e)
            {
                circuitBreaker.RecordFailure();
                Quietly(() => connectionLock?.Replace());
                Quietly(() => connectionLock?.Dispose());
                if (retryCount > 0)
                {
                    _logger.LogDebug(e,
                        "Error getting connection-lock for provider {Provider}. Retrying with a new connection.",
                        ProviderName);
                    retryCount--;
                    continue;
                }

                _logger.LogWarning(e, "Error getting connection-lock for provider {Provider}.", ProviderName);
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
                throw;
            }

            T? result;
            try
            {
                result = await command(connectionLock.Connection, OnConnectionReadyAgain).ConfigureAwait(false);
            }
            catch (Exception e) when (SingleConnectionNntpClient.IsCancellation(e))
            {
                Quietly(() => connectionLock.Dispose());
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
                throw;
            }
            catch (UsenetArticleNotFoundException)
            {
                Quietly(() => connectionLock.Dispose());
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
                throw;
            }
            catch (Exception e)
            {
                circuitBreaker.RecordFailure();
                Quietly(() => connectionLock.Replace());
                Quietly(() => connectionLock.Dispose());
                if (retryCount > 0)
                {
                    _logger.LogDebug(e,
                        "Error executing nntp {Command} command for provider {Provider}. Retrying with a new connection.",
                        name, ProviderName);
                    retryCount--;
                    continue;
                }

                _logger.LogWarning(e, "Error executing nntp {Command} command for provider {Provider}.",
                    name, ProviderName);
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
                throw;
            }

            circuitBreaker.RecordSuccess();

            // stat, head, and date commands are done with the connection immediately
            if (name is "STAT" or "HEAD" or "DATE")
            {
                Quietly(() => connectionLock.Dispose());
            }

            // body and article commands keep the connection until the body fully arrived
            else if ((result?.Success ?? false) == false)
            {
                Quietly(() => connectionLock.Dispose());
                Quietly(() => onConnectionReadyAgain?.Invoke(ArticleBodyResult.NotRetrieved));
            }

            return result!;

            void OnConnectionReadyAgain(ArticleBodyResult articleBodyResult)
            {
                if (articleBodyResult == ArticleBodyResult.NotRetrieved)
                {
                    Quietly(() => connectionLock.Replace());
                }

                Quietly(() => connectionLock.Dispose());
                Quietly(() => onConnectionReadyAgain?.Invoke(articleBodyResult));
            }
        }

        throw new InvalidOperationException("Unreachable code reached");
    }

    private void Quietly(Action? action)
    {
        try
        {
            action?.Invoke();
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Unhandled exception");
        }
    }

    public override void Dispose()
    {
        connectionPool.Dispose();
        GC.SuppressFinalize(this);
    }
}
