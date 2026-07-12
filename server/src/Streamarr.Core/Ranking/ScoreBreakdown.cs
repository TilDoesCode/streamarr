namespace Streamarr.Core.Ranking;

/// <summary>
/// One line of a score breakdown: the rule that contributed and its point value
/// (can be negative, e.g. a denied group). Surfaced verbatim by <c>/debug/search</c>
/// so an operator can see exactly why a release scored what it did (BRIEF.md §7.3).
/// </summary>
public sealed record ScoreLine(string Rule, int Points);

/// <summary>
/// The ranker's output: an integer total plus the per-rule breakdown that produced it.
/// This is the stable shape the API exposes; a future custom-format ranker can emit
/// the same shape without changing the contract.
/// </summary>
public sealed record ReleaseScore(int Total, IReadOnlyList<ScoreLine> Breakdown)
{
    public static readonly ReleaseScore Zero = new(0, []);
}
