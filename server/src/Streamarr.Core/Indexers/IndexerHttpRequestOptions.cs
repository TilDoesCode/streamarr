using Streamarr.Core.Providers;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Request option naming the indexer an HTTP request belongs to. The server's outbound routing handler reads it
/// to send the request through that indexer's tunnel (or to refuse it while the tunnel is down).
/// </summary>
public static class IndexerHttpRequestOptions
{
    public static readonly HttpRequestOptionsKey<IndexerConfig> Indexer = new("Streamarr.Indexer");

    /// <summary>Tags <paramref name="request"/> with its indexer.</summary>
    public static HttpRequestMessage ForIndexer(this HttpRequestMessage request, IndexerConfig indexer)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(indexer);
        request.Options.Set(Indexer, indexer);
        return request;
    }
}
