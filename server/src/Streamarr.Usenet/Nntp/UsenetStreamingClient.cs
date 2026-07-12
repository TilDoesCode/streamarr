// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/UsenetStreamingClient.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// built from a plain provider list instead of nzbdav's ConfigManager/Websocket stack.

using Microsoft.Extensions.Logging;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Usenet.Nntp;

/// <summary>
/// Composition root for the NNTP stack: builds one pooled client per configured
/// provider and fans commands out across them in priority order.
/// </summary>
public static class UsenetStreamingClient
{
    public static MultiProviderNntpClient Create(
        IEnumerable<UsenetProvider> providerList,
        ILoggerFactory? loggerFactory = null)
    {
        var providers = providerList
            .Where(p => p.Type != UsenetProviderType.Disabled)
            .Select(p => CreateProviderClient(p, loggerFactory))
            .ToList();

        var logger = loggerFactory?.CreateLogger<MultiProviderNntpClient>();
        return new MultiProviderNntpClient(providers, logger);
    }

    public static MultiConnectionNntpClient CreateProviderClient(
        UsenetProvider provider,
        ILoggerFactory? loggerFactory = null)
    {
        var connectionPool = new ConnectionPool<INntpClient>(
            maxConnections: provider.MaxConnections,
            connectionFactory: ct => CreateNewConnection(provider, ct));

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

    public static async ValueTask<INntpClient> CreateNewConnection
    (
        UsenetProvider provider,
        CancellationToken ct
    )
    {
        var connection = new SingleConnectionNntpClient();
        await connection.ConnectAsync(provider.Host, provider.Port, provider.UseSsl, ct).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(provider.Username))
            await connection.AuthenticateAsync(provider.Username, provider.Password, ct).ConfigureAwait(false);
        return connection;
    }
}
