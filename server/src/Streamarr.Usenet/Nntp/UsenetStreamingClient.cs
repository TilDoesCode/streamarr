// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/UsenetStreamingClient.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// built from a plain provider list instead of nzbdav's ConfigManager/Websocket stack.

using Microsoft.Extensions.Logging;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Usenet.Nntp;

/// <summary>
/// Composition root for the NNTP stack: builds one pooled client per configured
/// provider and fans commands out across them in priority order.
/// </summary>
public static class UsenetStreamingClient
{
    /// <summary>
    /// Pooled connections idle longer than this are DATE-probed before reuse — NNTP
    /// providers silently drop idle connections (observed within a few minutes on
    /// commercial servers), and serving a dead socket costs a failed command, a burned
    /// retry, and a circuit-breaker strike. One ~RTT probe per suspect borrow is cheap.
    /// </summary>
    private static readonly TimeSpan DefaultRevalidateIdleConnectionsAfter = TimeSpan.FromSeconds(60);

    private static readonly TimeSpan ConnectionProbeTimeout = TimeSpan.FromSeconds(5);

    public static MultiProviderNntpClient Create(
        IEnumerable<UsenetProvider> providerList,
        ILoggerFactory? loggerFactory = null,
        TimeSpan? connectionIdleTimeout = null)
    {
        var providers = providerList
            .Where(p => p.Type != UsenetProviderType.Disabled)
            .Select(p => CreateProviderClient(p, loggerFactory, connectionIdleTimeout))
            .ToList();

        var logger = loggerFactory?.CreateLogger<MultiProviderNntpClient>();
        return new MultiProviderNntpClient(providers, logger);
    }

    public static MultiConnectionNntpClient CreateProviderClient(
        UsenetProvider provider,
        ILoggerFactory? loggerFactory = null,
        TimeSpan? connectionIdleTimeout = null,
        TimeSpan? revalidateIdleConnectionsAfter = null)
    {
        var connectionPool = new ConnectionPool<INntpClient>(
            maxConnections: provider.MaxConnections,
            connectionFactory: ct => CreateNewConnection(provider, ct),
            idleTimeout: connectionIdleTimeout,
            connectionValidator: ProbeConnectionAsync,
            revalidateAfter: revalidateIdleConnectionsAfter ?? DefaultRevalidateIdleConnectionsAfter);

        var circuitBreaker = new ProviderCircuitBreaker(
            provider.Name,
            loggerFactory?.CreateLogger<ProviderCircuitBreaker>());

        return new MultiConnectionNntpClient(
            connectionPool,
            provider.Type,
            circuitBreaker,
            provider.Name,
            provider.Priority,
            loggerFactory?.CreateLogger<MultiConnectionNntpClient>());
    }

    /// <summary>
    /// Liveness probe for a pooled connection: DATE is stateless, answers in one round
    /// trip, and immediately exposes a socket the provider has silently closed. Bounded
    /// by its own short timeout so a half-open connection cannot stall a borrow.
    /// </summary>
    private static async ValueTask<bool> ProbeConnectionAsync(INntpClient client, CancellationToken ct)
    {
        using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        probeCts.CancelAfter(ConnectionProbeTimeout);
        var response = await client.DateAsync(probeCts.Token).ConfigureAwait(false);
        return response.Success;
    }

    public static async ValueTask<INntpClient> CreateNewConnection
    (
        UsenetProvider provider,
        CancellationToken ct
    )
    {
        var connection = new SingleConnectionNntpClient();
        try
        {
            await connection.ConnectAsync(provider.Host, provider.Port, provider.UseSsl, ct).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(provider.Username))
            {
                var auth = await connection.AuthenticateAsync(provider.Username, provider.Password, ct)
                    .ConfigureAwait(false);
                if (!auth.Success)
                    throw new CouldNotLoginToUsenetException(
                        $"Provider authentication failed with NNTP status {auth.ResponseCode}.");
            }

            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }
}
