using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
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
}

/// <summary>
/// Wires the full search pipeline (BRIEF §6.2 / §7): resolve free-text intent through
/// TMDB → canonical indexer fan-out → parse + identity-check → rank + reject → aggregate
/// to works, and registers every resolved release (with its server-side NZB URL) in the
/// store so <c>/resolve</c> can find it.
/// Both <c>/search</c> and <c>/debug/search</c> run this identical pipeline; they only
/// differ in how much of the <see cref="SearchAggregation"/> they project to the wire.
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
        var semanticTarget = await ResolveSemanticTargetAsync(query, context, cancellationToken);
        if (semanticTarget is not null)
            context = WithSemanticTarget(context, semanticTarget);

        // Once TMDB understands an alias such as "Dune 2", search the indexers with the
        // canonical title and stable ids. The indexer still receives q= as a compatibility
        // fallback for implementations that ignore one or both external-id parameters.
        var newznabQuery = semanticTarget is null
            ? BuildNewznabQuery(query, context)
            : BuildCanonicalNewznabQuery(semanticTarget, context);

        var indexerResult = await indexerSearch.SearchAsync(newznabQuery, cancellationToken);
        // A draft profile (live preview) overrides the stored/default selection.
        var profile = query.DraftProfile ?? profiles.Get(query.ProfileId);

        var aggregation = await aggregator.AggregateAsync(
            indexerResult.Releases,
            indexerResult.Outcomes,
            context,
            profile,
            cancellationToken);

        // A semantic query names one concrete TMDB work. Never advertise unrelated rows an
        // indexer happened to include in its page; a miss is a clean empty result.
        if (semanticTarget is not null)
            aggregation = KeepSemanticTarget(aggregation, semanticTarget);

        // Register every release (incl. rejected — a fallback may still pick one) so a
        // later /resolve can look it up. The store carries the NZB URL that never leaves
        // the server.
        foreach (var evaluated in aggregation.Releases)
            releaseStore.Register(evaluated.WorkId, evaluated.Release);

        return aggregation;
    }

    private async Task<TmdbMatch?> ResolveSemanticTargetAsync(
        SearchQuery query,
        SearchContext context,
        CancellationToken cancellationToken)
    {
        if (context.HasIds || string.IsNullOrWhiteSpace(query.Q))
            return null;

        var term = query.Q.Trim();
        return context.RequestedType switch
        {
            MediaType.Movie => await tmdb.SearchMovieAsync(term, year: null, cancellationToken),
            MediaType.Tv => await tmdb.SearchTvAsync(term, cancellationToken),
            _ => await tmdb.SearchAnyAsync(term, cancellationToken),
        };
    }

    private static SearchContext WithSemanticTarget(SearchContext context, TmdbMatch target)
        => context with
        {
            RequestedType = target.MediaType,
            ImdbId = target.ImdbId,
            TmdbId = target.TmdbId,
            CanonicalTitle = target.Title,
            CanonicalYear = target.Year,
            ResolvedTarget = target,
        };

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

    private static SearchAggregation KeepSemanticTarget(SearchAggregation aggregation, TmdbMatch target)
    {
        var works = aggregation.Works
            .Where(work => work.MediaType == target.MediaType && work.TmdbId == target.TmdbId)
            .ToArray();
        if (works.Length == 0)
            return SearchAggregation.Empty with { Outcomes = aggregation.Outcomes };

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
