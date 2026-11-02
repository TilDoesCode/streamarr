using System.Collections.Concurrent;
using System.Net;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// Sends indexer HTTP requests (Newznab caps/search, NZB downloads) over the route of the indexer named in the
/// request options: a connected tunnel's SOCKS5 proxy, the legacy <c>INDEXER_PROXY</c>, or direct. A request for a
/// tunnel that is not connected fails immediately with <see cref="TunnelUnavailableException"/> (never direct).
/// </summary>
public sealed class IndexerHttpRouter(
    ITunnelSupervisor supervisor,
    IOptions<StreamarrOptions> options,
    ILogger<IndexerHttpRouter> logger) : IDisposable
{
    private readonly ConcurrentDictionary<string, Lazy<HttpMessageInvoker>> _legacy = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, TunnelInvoker> _tunnels = new(StringComparer.Ordinal);

    /// <summary>A primary handler for an <see cref="IHttpClientFactory"/> client; all instances share this router's connections.</summary>
    public HttpMessageHandler CreateHandler(int? maxConnectionsPerServer = null) => new RoutingHandler(this, maxConnectionsPerServer);

    internal Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, int? maxConnectionsPerServer, CancellationToken ct)
    {
        if (!request.Options.TryGetValue(IndexerHttpRequestOptions.Indexer, out var indexer) || string.IsNullOrEmpty(indexer.TunnelId))
            return Legacy(maxConnectionsPerServer).SendAsync(request, ct);

        var proxy = supervisor.ProxyEndpoint(indexer.TunnelId);
        if (proxy is null)
        {
            var unavailable = supervisor.Unavailable(indexer.TunnelId);
            logger.LogDebug("Indexer {Indexer} request refused: {Reason}", indexer.Name, unavailable.Message);
            throw new HttpRequestException(unavailable.Message, unavailable);
        }
        return Tunnel(indexer.TunnelId, proxy, maxConnectionsPerServer).SendAsync(request, ct);
    }

    private HttpMessageInvoker Legacy(int? maxConnectionsPerServer)
        => _legacy.GetOrAdd(Key(maxConnectionsPerServer), _ => new Lazy<HttpMessageInvoker>(() =>
            new HttpMessageInvoker(OutboundHttpHandlerFactory.CreateIndexer(options.Value, maxConnectionsPerServer), disposeHandler: true))).Value;

    private HttpMessageInvoker Tunnel(string tunnelId, IPEndPoint proxy, int? maxConnectionsPerServer)
    {
        // A new connected episode (status.Since) means the helper restarted; pooled connections to the old process are dead.
        var since = supervisor.GetStatus(tunnelId)?.Since ?? DateTimeOffset.MinValue;
        var key = $"{tunnelId}|{Key(maxConnectionsPerServer)}";
        while (true)
        {
            var current = _tunnels.GetOrAdd(key, _ => new TunnelInvoker(proxy, since, maxConnectionsPerServer));
            if (current.Proxy.Equals(proxy) && current.Since == since)
                return current.Invoker;
            var replacement = new TunnelInvoker(proxy, since, maxConnectionsPerServer);
            if (_tunnels.TryUpdate(key, replacement, current))
            {
                current.Invoker.Dispose();
                return replacement.Invoker;
            }
            replacement.Invoker.Dispose();
        }
    }

    private static string Key(int? maxConnectionsPerServer) => maxConnectionsPerServer?.ToString() ?? "default";

    public void Dispose()
    {
        foreach (var lazy in _legacy.Values.Where(l => l.IsValueCreated))
            lazy.Value.Dispose();
        foreach (var entry in _tunnels.Values)
            entry.Invoker.Dispose();
    }

    private sealed record TunnelInvoker(IPEndPoint Proxy, DateTimeOffset Since, int? MaxConnectionsPerServer)
    {
        public HttpMessageInvoker Invoker { get; } =
            new(OutboundHttpHandlerFactory.CreateSocks5(Proxy, MaxConnectionsPerServer), disposeHandler: true);
    }

    private sealed class RoutingHandler(IndexerHttpRouter router, int? maxConnectionsPerServer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => router.SendAsync(request, maxConnectionsPerServer, cancellationToken);

        protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw new NotSupportedException("Synchronous indexer requests are not supported.");
    }
}
