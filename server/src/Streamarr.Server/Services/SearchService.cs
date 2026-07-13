using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Search;

namespace Streamarr.Server.Services;

/// <summary>Parameters accepted by <c>/search</c> and <c>/debug/search</c> (BRIEF §6.2).</summary>
public sealed record SearchQuery
{
    public required string Q { get; init; }

    /// <summary>"movie", "tv" or "any"/null.</summary>
    public string? Type { get; init; }

    public int? Season { get; init; }
    public int? Episode { get; init; }
    public string? ImdbId { get; init; }
    public int? TmdbId { get; init; }
    public string? ProfileId { get; init; }

    /// <summary>
    /// An unsaved draft profile to rank with (BRIEF §9.1 live preview). When set it takes
    /// precedence over <see cref="ProfileId"/>; used only by <c>/debug/search</c>.
    /// </summary>
    public QualityProfile? DraftProfile { get; init; }
}

/// <summary>
/// Wires the full M2 search pipeline (BRIEF §6.2 / §7): indexer fan-out → parse →
/// TMDB match + rank + reject → aggregate to works, and registers every resolved
/// release (with its server-side NZB URL) in the store so <c>/resolve</c> can find it.
/// Both <c>/search</c> and <c>/debug/search</c> run this identical pipeline; they only
/// differ in how much of the <see cref="SearchAggregation"/> they project to the wire.
/// </summary>
public sealed class SearchService(
    IndexerSearchService indexerSearch,
    WorkAggregator aggregator,
    IProfileProvider profiles,
    IReleaseStore releaseStore)
{
    public async Task<SearchAggregation> SearchAsync(SearchQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var context = BuildContext(query);
        var newznabQuery = BuildNewznabQuery(query, context);

        var indexerResult = await indexerSearch.SearchAsync(newznabQuery, cancellationToken);
        // A draft profile (live preview) overrides the stored/default selection.
        var profile = query.DraftProfile ?? profiles.Get(query.ProfileId);

        var aggregation = await aggregator.AggregateAsync(
            indexerResult.Releases,
            indexerResult.Outcomes,
            context,
            profile,
            cancellationToken);

        // Register every release (incl. rejected — a fallback may still pick one) so a
        // later /resolve can look it up. The store carries the NZB URL that never leaves
        // the server.
        foreach (var evaluated in aggregation.Releases)
            releaseStore.Register(evaluated.WorkId, evaluated.Release);

        return aggregation;
    }

    private static SearchContext BuildContext(SearchQuery query) => new()
    {
        RequestedType = ParseType(query.Type),
        ImdbId = string.IsNullOrWhiteSpace(query.ImdbId) ? null : query.ImdbId.Trim(),
        TmdbId = query.TmdbId,
        Season = query.Season,
        Episode = query.Episode,
    };

    private static NewznabQuery BuildNewznabQuery(SearchQuery query, SearchContext context)
    {
        var term = string.IsNullOrWhiteSpace(query.Q) ? null : query.Q.Trim();

        var kind = context.RequestedType switch
        {
            MediaType.Tv => NewznabSearchKind.Tv,
            MediaType.Movie when context.HasIds => NewznabSearchKind.Movie,
            _ => NewznabSearchKind.Search,
        };

        return new NewznabQuery
        {
            Kind = kind,
            Term = term,
            ImdbId = context.ImdbId,
            TmdbId = context.TmdbId,
            Season = context.Season,
            Episode = context.Episode,
        };
    }

    private static MediaType? ParseType(string? type) => type?.Trim().ToLowerInvariant() switch
    {
        "movie" => MediaType.Movie,
        "tv" => MediaType.Tv,
        _ => null,
    };
}
