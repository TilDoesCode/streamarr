namespace Streamarr.Core.Indexers;

/// <summary>Tunables for the indexer fan-out (BRIEF §6.1 module 1).</summary>
public sealed class IndexerSearchOptions
{
    /// <summary>Search-result cache lifetime (~60s per the brief).</summary>
    public int SearchCacheTtlSeconds { get; set; } = 60;

    /// <summary>Per-indexer request timeout; a slow indexer is dropped, not awaited.</summary>
    public int PerIndexerTimeoutSeconds { get; set; } = 30;

    /// <summary>Minimum gap between consecutive requests to the same indexer (rate limit).</summary>
    public int PerIndexerRateLimitMilliseconds { get; set; } = 1000;

    /// <summary>Result cap sent to each indexer when the query doesn't set one.</summary>
    public int DefaultLimit { get; set; } = 100;

    /// <summary>Maximum bytes accepted from one Newznab XML response.</summary>
    public int MaxResponseBytes { get; set; } = 16 * 1024 * 1024;

    /// <summary>Maximum enabled indexers included in one fan-out.</summary>
    public int MaxIndexersPerSearch { get; set; } = 32;

    /// <summary>Process-wide maximum number of in-flight Newznab requests.</summary>
    public int MaxConcurrentIndexerRequests { get; set; } = 8;

    public TimeSpan CacheTtl => TimeSpan.FromSeconds(Math.Max(0, SearchCacheTtlSeconds));
    public TimeSpan PerIndexerTimeout => TimeSpan.FromSeconds(Math.Max(1, PerIndexerTimeoutSeconds));
    public TimeSpan RateLimitInterval => TimeSpan.FromMilliseconds(Math.Max(0, PerIndexerRateLimitMilliseconds));
}
