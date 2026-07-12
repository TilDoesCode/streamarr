using Streamarr.Core.Media;

namespace Streamarr.Core.Indexers;

public enum IndexerOutcomeStatus
{
    Succeeded,
    TimedOut,
    Failed,
}

/// <summary>Per-indexer diagnostics from a fan-out — surfaced by /debug and the UI.</summary>
public sealed record IndexerOutcome
{
    public required string IndexerId { get; init; }
    public required string IndexerName { get; init; }
    public required IndexerOutcomeStatus Status { get; init; }

    /// <summary>Items the indexer returned (before cross-indexer dedupe).</summary>
    public int ItemCount { get; init; }

    public TimeSpan Elapsed { get; init; }

    /// <summary>Present when <see cref="Status"/> is not <see cref="IndexerOutcomeStatus.Succeeded"/>.</summary>
    public string? Error { get; init; }

    public bool Succeeded => Status == IndexerOutcomeStatus.Succeeded;
}

/// <summary>
/// Result of a fan-out search: the deduped, indexer-priority-ordered releases plus
/// per-indexer outcomes. Ranking, TMDB matching and aggregation to works happen in
/// later M2 stages; here <see cref="Release.Score"/> is 0 and quality is unparsed.
/// </summary>
public sealed record IndexerSearchResult
{
    public required IReadOnlyList<Release> Releases { get; init; }
    public required IReadOnlyList<IndexerOutcome> Outcomes { get; init; }

    /// <summary>True when served from the search cache rather than a live fan-out.</summary>
    public bool FromCache { get; init; }

    public static readonly IndexerSearchResult Empty = new()
    {
        Releases = [],
        Outcomes = [],
    };
}
