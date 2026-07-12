using Streamarr.Core.Media;
using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// The full assessment of one release: whether it was rejected (and why) and its
/// score breakdown. This is the rich, API-facing shape <c>/debug/search</c> surfaces;
/// the plain <see cref="Release"/> DTO carries only the flattened summary.
/// </summary>
public sealed record ReleaseAssessment
{
    public required ReleaseScore Score { get; init; }
    public required IReadOnlyList<RejectionReason> Rejections { get; init; }

    public bool Rejected => Rejections.Count > 0;
}

/// <summary>
/// Ties the rejection engine and ranker together (BRIEF.md §7.2 + §7.3): a release is
/// scored regardless of rejection (so the debug view still shows its would-be score),
/// but rejected releases sort below every accepted one.
/// </summary>
public sealed class ReleaseEvaluator(IRejectionEngine rejectionEngine, IReleaseRanker ranker)
{
    /// <summary>Convenience constructor wiring the default engine + weighted-sum ranker.</summary>
    public ReleaseEvaluator()
        : this(new RejectionEngine(), new WeightedSumRanker())
    {
    }

    public ReleaseAssessment Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        ArgumentNullException.ThrowIfNull(signals);
        ArgumentNullException.ThrowIfNull(profile);

        return new ReleaseAssessment
        {
            Rejections = rejectionEngine.Evaluate(signals, profile),
            Score = ranker.Score(signals, profile),
        };
    }

    /// <summary>Flatten an assessment onto a <see cref="Release"/> DTO for the public API.</summary>
    public static Release Apply(Release release, ReleaseAssessment assessment)
    {
        ArgumentNullException.ThrowIfNull(release);
        ArgumentNullException.ThrowIfNull(assessment);

        return release with
        {
            Score = assessment.Score.Total,
            Rejected = assessment.Rejected,
            RejectionReasons = assessment.Rejections.Select(r => r.ToString()).ToArray(),
        };
    }

    /// <summary>
    /// Order releases for a work (BRIEF.md §7.3/§7.4): accepted releases first, then by
    /// descending score, then by size as a stable tiebreak. Rejected releases follow,
    /// ordered the same way so a fallback still prefers the best of a bad lot.
    /// </summary>
    public static IReadOnlyList<Release> Order(IEnumerable<Release> releases)
        => releases
            .OrderBy(r => r.Rejected)
            .ThenByDescending(r => r.Score)
            .ThenByDescending(r => r.SizeBytes)
            .ToArray();
}
