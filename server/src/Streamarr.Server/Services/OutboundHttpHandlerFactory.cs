using System.Net;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// Makes outbound routing policy explicit instead of inheriting process-wide proxy
/// environment variables through <see cref="HttpClient"/> defaults.
/// </summary>
internal static class OutboundHttpHandlerFactory
{
    public static SocketsHttpHandler CreateIndexer(
        StreamarrOptions options,
        int? maxConnectionsPerServer = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        Uri? proxyUri = string.IsNullOrEmpty(options.IndexerProxy)
            ? null
            : new Uri(options.IndexerProxy, UriKind.Absolute);

        return Create(proxyUri, maxConnectionsPerServer);
    }

    public static SocketsHttpHandler CreateDirect()
        => Create(proxyUri: null);

    private static SocketsHttpHandler Create(Uri? proxyUri, int? maxConnectionsPerServer = null)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            // Proxy = null normally asks .NET for the process/system proxy. Set
            // UseProxy explicitly so generic HTTP_PROXY/HTTPS_PROXY variables cannot
            // alter Streamarr's per-client routing policy.
            UseProxy = proxyUri is not null,
            Proxy = proxyUri is null
                ? null
                : new WebProxy(proxyUri) { BypassProxyOnLocal = false },
        };

        if (maxConnectionsPerServer is { } maxConnections)
            handler.MaxConnectionsPerServer = maxConnections;

        return handler;
    }
}
