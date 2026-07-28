using Streamarr.Plugin.Search;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Pins the numeric relationship the "metadata loads unreliably" fix depends on. The plugin and
/// Core Server are separate processes/solutions (the plugin only ever talks to Core over HTTP —
/// see docs/jellyfin-compatibility.md), so this can't reference <c>TmdbOptions</c> directly; the
/// 20s figure below is Core's <c>TmdbOptions.RequestTimeoutSeconds</c> default (the
/// <c>CachingTmdbClient</c> upstream ceiling), and <c>Streamarr.Core.Tests</c>'s
/// <c>TmdbSlowButSuccessfulRetryTests</c> proves a realistic multi-retry 429 sequence can take
/// longer than the plugin's old 12s hierarchy-population budget while still fitting under that
/// 20s ceiling. If <c>HierarchyTimeout</c> ever regresses below Core's TMDB ceiling, a TMDB
/// response that is merely slow (retrying a transient failure) is discarded by the plugin before
/// Core even finishes, and Jellyfin Web/Streamyfin see an empty/partial season with no error.
/// </summary>
public class HierarchyTimeoutBudgetTests
{
    /// <summary>Core defaults — keep in sync with TmdbOptions and IndexerSearchOptions.</summary>
    private static readonly TimeSpan CoreDefaultTmdbCeiling = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan CoreDefaultIndexerCeiling = TimeSpan.FromSeconds(30);

    [Fact]
    public void HierarchyTimeout_exceeds_Cores_sequential_TMDB_and_indexer_ceilings_with_headroom()
    {
        var coldSeasonCeiling = CoreDefaultTmdbCeiling + CoreDefaultIndexerCeiling;
        Assert.True(
            StreamarrSearchActionFilter.HierarchyTimeout > coldSeasonCeiling,
            $"HierarchyTimeout ({StreamarrSearchActionFilter.HierarchyTimeout}) must stay above Core's "
            + $"sequential TMDB + indexer ceiling ({coldSeasonCeiling}) or a slow-but-successful "
            + "cold season load gets silently discarded before Core can finish.");
    }
}
