using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Ranking;

namespace Streamarr.Core.Search;

/// <summary>
/// One release after the full search pipeline: the enriched <see cref="Release"/> DTO
/// (score / rejection / quality flattened on), the raw <see cref="ParsedReleaseInfo"/>,
/// the full <see cref="ReleaseAssessment"/> (score breakdown + rejection reasons), and
/// the id of the work it was aggregated under. <c>/search</c> reads the summary;
/// <c>/debug/search</c> reads the parse + breakdown (BRIEF §6.2).
/// </summary>
public sealed record EvaluatedRelease
{
    public required string WorkId { get; init; }
    public required Release Release { get; init; }
    public required ParsedReleaseInfo Parsed { get; init; }
    public required ReleaseAssessment Assessment { get; init; }
}

/// <summary>
/// The output of the search pipeline: releases aggregated to ranked <see cref="Work"/>s
/// (BRIEF §7.4), the flat list of every <see cref="EvaluatedRelease"/> (incl. rejected,
/// for <c>/debug/search</c>), and the per-indexer fan-out diagnostics.
/// </summary>
public sealed record SearchAggregation
{
    public required IReadOnlyList<Work> Works { get; init; }
    public required IReadOnlyList<EvaluatedRelease> Releases { get; init; }
    public required IReadOnlyList<IndexerOutcome> Outcomes { get; init; }

    public static readonly SearchAggregation Empty = new()
    {
        Works = [],
        Releases = [],
        Outcomes = [],
    };
}
