namespace Streamarr.Server.Services;

/// <summary>
/// Raised by <see cref="NzbFetcher"/> when an NZB download link resolves to an origin
/// that is neither the indexer's configured BaseUrl origin nor one of its allowed
/// download hosts (BRIEF §6.3 SSRF guard). Derives from <see cref="IOException"/> — the
/// base of the fetcher's other data-rejection exceptions — while carrying the offending
/// <see cref="Host"/> and owning indexer so front-ends can offer to add the host to the
/// indexer's allow-list.
/// </summary>
public sealed class NzbOriginNotAllowedException(
    string host,
    string configuredOrigin,
    string indexerId,
    string indexerName)
    : IOException(
        $"The NZB download host '{host}' is not allowed for indexer '{indexerName}'. " +
        $"Add it to the indexer's allowed download hosts if this host is legitimate.")
{
    /// <summary>The download host that was rejected (e.g. <c>dl.indexer.example</c>).</summary>
    public string Host { get; } = host;

    /// <summary>The indexer's configured origin (scheme://host[:port]).</summary>
    public string ConfiguredOrigin { get; } = configuredOrigin;

    public string IndexerId { get; } = indexerId;
    public string IndexerName { get; } = indexerName;
}
