using Streamarr.Core.Providers;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Talks to a single Newznab indexer over its HTTP API (BRIEF §6.1 module 1):
/// <c>t=caps</c>, <c>t=search</c>, <c>t=movie&amp;imdbid=</c>, <c>t=tvsearch</c>.
/// The fan-out (<see cref="IndexerSearchService"/>) calls this once per indexer;
/// rate limiting, timeouts, caching and dedupe live in the fan-out, not here.
/// </summary>
public interface INewznabClient
{
    Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken);

    Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken);
}
