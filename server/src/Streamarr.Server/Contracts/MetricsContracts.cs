namespace Streamarr.Server.Contracts;

/// <summary>
/// Snapshot returned by GET /api/v1/metrics (BRIEF §10-M7 observability): live sessions,
/// NNTP connections vs the global budget, cumulative bytes streamed, resolve/fallback
/// counts, search-cache hit rate, and per-indexer latency.
/// </summary>
public sealed record MetricsResponse
{
    public required SessionMetrics Sessions { get; init; }
    public required ConnectionMetrics Connections { get; init; }
    public required ResolveMetrics Resolves { get; init; }
    public required SearchCacheMetrics SearchCache { get; init; }
    public long BytesServedTotal { get; init; }
    public IReadOnlyList<IndexerLatencyMetric> Indexers { get; init; } = [];

    /// <summary>PAR2 repair pipeline counters (additive; absent on older servers).</summary>
    public RepairMetrics? Repairs { get; init; }
}

/// <summary>Low-cardinality repair counters; failure reasons are disposition names only.</summary>
public sealed record RepairMetrics
{
    public int ActiveJobs { get; init; }
    public long AttemptsTotal { get; init; }
    public long SucceededTotal { get; init; }
    public long FailedTotal { get; init; }
    public long CancelledTotal { get; init; }
    public long CacheHitsTotal { get; init; }
    public long ArtifactEvictionsTotal { get; init; }
    public long WaitAtHoleStartedTotal { get; init; }
    public long WaitAtHoleResumedTotal { get; init; }
    public double WaitAtHoleSecondsTotal { get; init; }
    public long ArtifactBytes { get; init; }
    public IReadOnlyDictionary<string, long> FailuresByReason { get; init; }
        = new Dictionary<string, long>();
}

public sealed record SessionMetrics
{
    /// <summary>Sessions currently live.</summary>
    public int Active { get; init; }
    public long OpenedTotal { get; init; }
    public long ClosedTotal { get; init; }
}

public sealed record ConnectionMetrics
{
    /// <summary>The global NNTP connection budget shared across all sessions.</summary>
    public int Budget { get; init; }

    /// <summary>NNTP commands currently occupying a connection across all sessions.</summary>
    public int InUse { get; init; }

    public IReadOnlyList<ProviderConnectionMetric> Providers { get; init; } = [];
}

public sealed record ProviderConnectionMetric
{
    public required string Name { get; init; }
    public int Priority { get; init; }
    public int LiveConnections { get; init; }
    public int ActiveConnections { get; init; }
    public int IdleConnections { get; init; }
    public int AvailableConnections { get; init; }

    /// <summary>True while the provider's circuit breaker is open (failover in effect).</summary>
    public bool Tripped { get; init; }
}

public sealed record ResolveMetrics
{
    public long Total { get; init; }

    /// <summary>Resolves that returned a release reached via auto-fallback.</summary>
    public long ViaFallback { get; init; }
}

public sealed record SearchCacheMetrics
{
    public int Entries { get; init; }
    public long Hits { get; init; }
    public long Misses { get; init; }

    /// <summary>Hit / (hit + miss); 0 when no lookups have happened yet.</summary>
    public double HitRate { get; init; }
}

public sealed record IndexerLatencyMetric
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public long Requests { get; init; }
    public long Failures { get; init; }
    public double LastLatencyMs { get; init; }
    public double AvgLatencyMs { get; init; }
}
