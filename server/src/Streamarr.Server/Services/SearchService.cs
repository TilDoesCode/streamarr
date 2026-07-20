using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Core.Search;
using Streamarr.Core.Tmdb;

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

    /// <summary>
    /// Keep unidentified and unrelated parser buckets for the admin diagnostics projection.
    /// Public discovery leaves this false and receives only TMDB candidate intersections.
    /// </summary>
    public bool PreserveDiagnosticBuckets { get; init; }

    /// <summary>
    /// Internal canonical identity supplied by catalog expansion. It avoids repeating a TMDB
    /// detail lookup and guarantees that a season query cannot attach another similarly named
    /// show to the requested series.
    /// </summary>
    public TmdbMatch? ResolvedTarget { get; init; }
}

/// <summary>
/// Wires the full search pipeline (BRIEF §6.2 / §7): resolve free-text intent through
/// TMDB → canonical indexer fan-out → parse + identity-check → rank + reject → aggregate
/// to works, and registers every resolved release (with its server-side NZB URL) in the
/// store so <c>/resolve</c> can find it.
/// Both <c>/search</c> and <c>/debug/search</c> run this identical pipeline; public discovery
/// retains only semantic intersections while diagnostics also retain raw parser buckets.
/// </summary>
public sealed class SearchService(
    IndexerSearchService indexerSearch,
    WorkAggregator aggregator,
    ITmdbClient tmdb,
    IProfileProvider profiles,
    IReleaseStore releaseStore)
{
    public async Task<SearchAggregation> SearchAsync(SearchQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var context = BuildContext(query);
        var semanticCandidates = query.ResolvedTarget is { } supplied
            ? (IReadOnlyList<TmdbMatch>)[supplied]
            : await ResolveSemanticCandidatesAsync(query, context, cancellationToken);

        // Public discovery is defined as the intersection of TMDB intent and indexer
        // availability. If TMDB found no work, there is nothing safe to ask an indexer
        // for: a broad indexer response could otherwise be independently resolved to an
        // unrelated TMDB id by the aggregator and escape the public id-only projection.
        // Diagnostics intentionally retain their raw parser/indexer view for operators.
        if (semanticCandidates.Count == 0
            && (context.HasIds || !string.IsNullOrWhiteSpace(query.Q))
            && !query.PreserveDiagnosticBuckets)
        {
            return SearchAggregation.Empty;
        }

        if (semanticCandidates.Count > 0)
        {
            var primary = semanticCandidates[0];
            context = context with
            {
                SemanticCandidates = semanticCandidates,
                ResolvedTarget = semanticCandidates.Count == 1 ? primary : null,
                CanonicalTitle = semanticCandidates.Count == 1 ? primary.Title : null,
                CanonicalYear = semanticCandidates.Count == 1 ? primary.Year : null,
            };
        }

        // A single clear TMDB match can use stable ids. A genuine discovery result set uses
        // the user's term once, then intersects the returned release groups with the ordered
        // TMDB candidates in WorkAggregator.
        var newznabQuery = semanticCandidates.Count == 1
            ? BuildCanonicalNewznabQuery(semanticCandidates[0], context)
            : BuildNewznabQuery(query, context);

        var indexerResult = await indexerSearch.SearchAsync(newznabQuery, cancellationToken);
        // A draft profile (live preview) overrides the stored/default selection.
        var effectiveMediaType = context.RequestedType ??
            (semanticCandidates.Count == 1 ? semanticCandidates[0].MediaType : null);
        var profile = query.DraftProfile ?? profiles.Get(query.ProfileId, effectiveMediaType);

        var aggregation = await aggregator.AggregateAsync(
            indexerResult.Releases,
            indexerResult.Outcomes,
            context,
            profile,
            cancellationToken);

        if (semanticCandidates.Count > 0)
            aggregation = ApplySemanticCandidates(
                aggregation,
                semanticCandidates,
                query.PreserveDiagnosticBuckets);

        // Register every release (incl. rejected — a fallback may still pick one) so a
        // later /resolve can look it up. The store carries the NZB URL that never leaves
        // the server.
        releaseStore.RegisterRange(aggregation.Releases.Select(evaluated => new RegisteredRelease
        {
            WorkId = evaluated.WorkId,
            Release = evaluated.Release,
        }));

        return aggregation;
    }

    private async Task<IReadOnlyList<TmdbMatch>> ResolveSemanticCandidatesAsync(
        SearchQuery query,
        SearchContext context,
        CancellationToken cancellationToken)
    {
        if (context.HasIds)
        {
            TmdbMatch? target;
            if (context.TmdbId is { } tmdbId)
            {
                // TMDB ids are scoped by media type. Preserve the historical movie default
                // for an omitted type, while an explicit TV request uses the TV namespace.
                target = context.RequestedType == MediaType.Tv
                    ? await tmdb.GetTvAsync(tmdbId, cancellationToken)
                    : await tmdb.GetMovieAsync(tmdbId, cancellationToken);
            }
            else
            {
                target = await tmdb.FindByImdbAsync(context.ImdbId!, cancellationToken);
            }

            if (target is null
                || context.RequestedType is { } requestedType && target.MediaType != requestedType)
            {
                return [];
            }

            return [target];
        }

        if (string.IsNullOrWhiteSpace(query.Q))
            return [];

        var term = query.Q.Trim();
        return await tmdb.SearchCandidatesAsync(term, context.RequestedType, cancellationToken);
    }

    private static NewznabQuery BuildCanonicalNewznabQuery(TmdbMatch target, SearchContext context)
        => new()
        {
            Kind = target.MediaType == MediaType.Tv
                ? NewznabSearchKind.Tv
                : NewznabSearchKind.Movie,
            Term = target.Title,
            ImdbId = target.ImdbId,
            TmdbId = target.TmdbId,
            Season = context.Season,
            Episode = context.Episode,
        };

    private static SearchAggregation ApplySemanticCandidates(
        SearchAggregation aggregation,
        IReadOnlyList<TmdbMatch> candidates,
        bool preserveDiagnosticBuckets)
    {
        var order = candidates
            .Select((candidate, index) => (candidate, index))
            .GroupBy(item => (item.candidate.MediaType, item.candidate.TmdbId))
            .ToDictionary(group => group.Key, group => group.Min(item => item.index));

        var identified = aggregation.Works
            .Where(work => work.TmdbId is { } id && order.ContainsKey((work.MediaType, id)))
            .GroupBy(work => work.WorkId, StringComparer.Ordinal)
            .Select(group =>
            {
                var first = group.First();
                var releases = group
                    .SelectMany(work => work.Releases)
                    .GroupBy(release => release.ReleaseId, StringComparer.Ordinal)
                    .Select(releases => releases.First());
                return first with { Releases = ReleaseEvaluator.Order(releases) };
            })
            .OrderBy(work => order[(work.MediaType, work.TmdbId!.Value)])
            .ThenBy(work => work.Season)
            .ThenBy(work => work.Episode)
            .ThenBy(work => work.Title, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var works = preserveDiagnosticBuckets
            ? identified.Concat(aggregation.Works.Where(work =>
                work.TmdbId is not { } id || !order.ContainsKey((work.MediaType, id)))).ToArray()
            : identified;
        if (works.Length == 0)
            return SearchAggregation.Empty with { Outcomes = aggregation.Outcomes };

        if (preserveDiagnosticBuckets)
            return aggregation with { Works = works };

        var workIds = works.Select(work => work.WorkId).ToHashSet(StringComparer.Ordinal);
        return aggregation with
        {
            Works = works,
            Releases = aggregation.Releases.Where(release => workIds.Contains(release.WorkId)).ToArray(),
        };
    }

    private static SearchContext BuildContext(SearchQuery query) => new()
    {
        RequestedType = ParseType(query.Type),
        ImdbId = string.IsNullOrWhiteSpace(query.ImdbId) ? null : query.ImdbId.Trim(),
        TmdbId = query.TmdbId,
        Season = query.Season,
        Episode = query.Episode,
        ResolvedTargetIsAuthoritative = query.ResolvedTarget is not null,
    };

    private static NewznabQuery BuildNewznabQuery(SearchQuery query, SearchContext context)
    {
        var term = string.IsNullOrWhiteSpace(query.Q) ? null : query.Q.Trim();

        var kind = context.RequestedType switch
        {
            MediaType.Tv => NewznabSearchKind.Tv,
            MediaType.Movie => NewznabSearchKind.Movie,
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
