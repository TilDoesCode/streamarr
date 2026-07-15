using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Search;

/// <summary>
/// ⚠️ KNOWN-FRAGILE — version-sensitive coupling to Jellyfin's HTTP pipeline (BRIEF §8.2,
/// §11, §13; DECISIONS.md #2). This is the <b>single</b> file that binds to Jellyfin
/// internals for the search-interception feature. If a future Jellyfin release changes any of
/// the following, only this file needs updating (see docs/jellyfin-compatibility.md):
/// <list type="bullet">
    /// <item>the <c>/Items</c>, <c>/Shows/{id}/Seasons</c>, and
    /// <c>/Shows/{id}/Episodes</c> actions returning <see cref="QueryResult{BaseItemDto}"/>, plus
    /// <c>/Search/Hints</c> returning <see cref="SearchHintResult"/> (both route and response type
    /// are checked; other Jellyfin endpoints reuse these DTOs for people/artists);</item>
/// <item>the <c>searchTerm</c> query-string key;</item>
/// <item><see cref="IDtoService.GetBaseItemDto"/>'s signature.</item>
/// </list>
/// <para>
/// <b>Every</b> code path is wrapped so that any error, timeout, or mismatch falls through to the
/// unmodified native result. Killing the Core Server, disabling the toggle, or a Jellyfin ABI
/// drift must never break native library search — it only means no Usenet works are injected.
/// The filter contains no domain logic: ranking, health and metadata are all the Core Server's;
/// it only materializes what the server returned and merges it into the response (BRIEF §11).
/// </para>
/// </summary>
public sealed class StreamarrSearchActionFilter(
    StreamarrApiClient api,
    EphemeralLibraryService library,
    HierarchyLoadCoordinator hierarchyLoads,
    IDtoService dtoService,
    IImageProcessor imageProcessor,
    IUserManager userManager,
    ILibraryManager libraryManager,
    ILogger<StreamarrSearchActionFilter> logger) : IAsyncActionFilter
{
    /// <summary>Search must never stall a keystroke: a slow Core Server is treated as absent.</summary>
    private static readonly TimeSpan InterceptTimeout = TimeSpan.FromSeconds(4);

    /// <summary>An opened season may perform one real indexer fan-out before its episodes exist.</summary>
    private static readonly TimeSpan HierarchyTimeout = TimeSpan.FromSeconds(12);

    /// <summary>Upper bound on works materialized per search, to bound request cost.</summary>
    private const int MaxWorks = 20;
    private const int MaxSeries = 3;
    private const int MaxRecursiveSeasonConcurrency = 3;
    private const int MaxSearchTermLength = 256;

    private const string SearchTermKey = "searchTerm";

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var config = Plugin.Instance?.Configuration;
        var interceptionEnabled = config is not null && config.InterceptionEnabled;
        if (interceptionEnabled)
        {
            try
            {
                if (TryGetHierarchyRequest(context, out var hierarchyRequest))
                {
                    using var hierarchyTimeout = CancellationTokenSource.CreateLinkedTokenSource(
                        context.HttpContext.RequestAborted);
                    hierarchyTimeout.CancelAfter(HierarchyTimeout);
                    await EnsureHierarchyAsync(
                                hierarchyRequest,
                                context.HttpContext,
                                hierarchyTimeout.Token)
                            .WaitAsync(HierarchyTimeout, context.HttpContext.RequestAborted)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                // Population is deliberately before the native action: when it succeeds Jellyfin
                // applies its complete query/filter/sort/projection semantics to the cold response.
                // Failure still falls through to the untouched native action.
                logger.LogWarning(
                    "Streamarr hierarchy population failed ({FailureType}); continuing with native results",
                    ex.GetType().Name);
            }
        }

        var executed = await next().ConfigureAwait(false);

        try
        {
            if (!interceptionEnabled)
                return;

            if (executed.Result is not ObjectResult obj || obj.Value is null)
                return;

            var request = context.HttpContext.Request;
            var ct = context.HttpContext.RequestAborted;
            switch (obj.Value)
            {
                case QueryResult<BaseItemDto> items:
                {
                    if (!IsSupportedSearchPath(request.Path, isHintRequest: false))
                        break;

                    var term = GetSearchTerm(request);
                    if (!string.IsNullOrWhiteSpace(term))
                    {
                        obj.Value = await InjectItemsAsync(items, term, context.HttpContext, ct).ConfigureAwait(false);
                    }
                    break;
                }
                case SearchHintResult hints
                    when IsSupportedSearchPath(request.Path, isHintRequest: true):
                {
                    var term = GetSearchTerm(request);
                    if (!string.IsNullOrWhiteSpace(term))
                        obj.Value = await InjectHintsAsync(hints, term, context.HttpContext, ct).ConfigureAwait(false);
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            // Non-negotiable: interception failure degrades to native results (BRIEF §11).
            logger.LogWarning(
                "Streamarr search interception failed ({FailureType}); returning native results unchanged",
                ex.GetType().Name);
        }
    }

    private async Task<QueryResult<BaseItemDto>> InjectItemsAsync(
        QueryResult<BaseItemDto> native,
        string term,
        HttpContext http,
        CancellationToken ct)
    {
        var constraints = GetConstraints(http.Request, isHintRequest: false);
        var capacity = constraints.RemainingCapacity(native.Items.Count, native.Items.Count + MaxWorks);
        if (capacity == 0)
            return native;

        var user = ResolveUser(http);
        if (user is null)
            return native;

        var discovery = await FetchDiscoveryAsync(term, constraints, ct).ConfigureAwait(false);
        if (discovery.Movies.Count == 0 && discovery.Series.Count == 0)
            return native;

        var dtoOptions = new DtoOptions(true) { EnableUserData = true };
        var injected = new List<BaseItemDto>(Math.Min(discovery.Count, capacity));
        foreach (var movie in discovery.Movies)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeAsync(movie, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item)
                    continue;
                if (!CanExposeToUser(item, isTv: false, user))
                    continue;
                injected.Add(dtoService.GetBaseItemDto(item, dtoOptions, user, null!));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral movie {WorkId} during item injection", movie.WorkId);
            }
        }

        foreach (var series in discovery.Series)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeSeriesAsync(series, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item
                    || !CanExposeToUser(item, isTv: true, user))
                {
                    continue;
                }

                injected.Add(dtoService.GetBaseItemDto(item, dtoOptions, user, null!));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral series {WorkId} during item injection", series.WorkId);
            }
        }

        var merged = SearchInjection.MergeItems(native.Items, injected);
        var added = merged.Count - native.Items.Count;
        logger.LogDebug("Injected {Added} Streamarr movie/series item(s) into an /Items search", added);
        return new QueryResult<BaseItemDto>(native.StartIndex, native.TotalRecordCount + added, merged);
    }

    private async Task<SearchHintResult> InjectHintsAsync(
        SearchHintResult native,
        string term,
        HttpContext http,
        CancellationToken ct)
    {
        var constraints = GetConstraints(http.Request, isHintRequest: true);
        var capacity = constraints.RemainingCapacity(native.SearchHints.Count, native.SearchHints.Count + MaxWorks);
        if (capacity == 0)
            return native;

        var user = ResolveUser(http);
        if (user is null)
            return native;

        var discovery = await FetchDiscoveryAsync(term, constraints, ct).ConfigureAwait(false);
        if (discovery.Movies.Count == 0 && discovery.Series.Count == 0)
            return native;

        var injected = new List<SearchHint>(Math.Min(discovery.Count, capacity));
        foreach (var movie in discovery.Movies)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeAsync(movie, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item
                    || !CanExposeToUser(item, isTv: false, user))
                {
                    continue;
                }

                injected.Add(SearchInjection.BuildHint(
                    itemId,
                    movie,
                    ImageTag(item, ImageType.Primary),
                    ImageTag(item, ImageType.Backdrop)));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral movie {WorkId} during hint injection", movie.WorkId);
            }
        }

        foreach (var series in discovery.Series)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeSeriesAsync(series, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item
                    || !CanExposeToUser(item, isTv: true, user))
                {
                    continue;
                }

                injected.Add(SearchInjection.BuildSeriesHint(
                    itemId,
                    series,
                    ImageTag(item, ImageType.Primary),
                    ImageTag(item, ImageType.Backdrop)));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral series {WorkId} during hint injection", series.WorkId);
            }
        }

        var merged = SearchInjection.MergeHints(native.SearchHints, injected);
        var added = merged.Count - native.SearchHints.Count;
        logger.LogDebug("Injected {Added} Streamarr hint(s) into /Search/Hints", added);
        return new SearchHintResult(merged, native.TotalRecordCount + added);
    }

    private sealed record DiscoveryResults(
        IReadOnlyList<WorkDto> Movies,
        IReadOnlyList<TvSeriesDto> Series)
    {
        public int Count => Movies.Count + Series.Count;
    }

    private sealed record HierarchyRequest(
        Guid ParentId,
        BaseItemKind ChildKind,
        int? SeasonNumber,
        Guid? ExpectedSeriesId,
        bool SupportsRecursive);

    /// <summary>
    /// Runs movie availability and bounded TV-series discovery concurrently under the keystroke
    /// deadline. TV discovery is metadata-only: no episode/indexer query occurs until navigation.
    /// Either branch may fail independently without suppressing results from the other.
    /// </summary>
    private async Task<DiscoveryResults> FetchDiscoveryAsync(
        string term,
        SearchInjection.Constraints constraints,
        CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(InterceptTimeout);
        var moviesTask = constraints.AllowsMovieDiscovery
            ? FetchMoviesAsync(term, constraints, cts.Token)
            : Task.FromResult<IReadOnlyList<WorkDto>>([]);
        var seriesTask = constraints.AllowsSeriesDiscovery
            ? FetchSeriesAsync(term, constraints, cts.Token)
            : Task.FromResult<IReadOnlyList<TvSeriesDto>>([]);

        await Task.WhenAll(moviesTask, seriesTask).ConfigureAwait(false);
        return new DiscoveryResults(await moviesTask.ConfigureAwait(false), await seriesTask.ConfigureAwait(false));
    }

    private async Task<IReadOnlyList<WorkDto>> FetchMoviesAsync(
        string term,
        SearchInjection.Constraints constraints,
        CancellationToken ct)
    {
        try
        {
            var response = await api.SearchAsync(term, "movie", ct).ConfigureAwait(false);
            return response?.Results
                       .Where(w => w.Releases.Count > 0)
                       .Where(w => !SearchInjection.IsEpisode(w))
                       .Where(constraints.Allows)
                       .Take(MaxWorks)
                       .ToList()
                   ?? [];
        }
        catch (Exception ex)
        {
            logger.LogDebug("Core movie search unavailable ({FailureType})", ex.GetType().Name);
            return [];
        }
    }

    private async Task<IReadOnlyList<TvSeriesDto>> FetchSeriesAsync(
        string term,
        SearchInjection.Constraints constraints,
        CancellationToken ct)
    {
        try
        {
            var response = await api.SearchTvSeriesAsync(term, ct).ConfigureAwait(false);
            return response?.Results
                       .Where(constraints.AllowsSeries)
                       .Take(MaxSeries)
                       .ToList()
                   ?? [];
        }
        catch (Exception ex)
        {
            logger.LogDebug("Core TV-series discovery unavailable ({FailureType})", ex.GetType().Name);
            return [];
        }
    }

    /// <summary>
    /// Populates before Jellyfin's action executes, so the cold response uses Jellyfin's native
    /// filtering, sorting, paging, adjacent-item, projection, user-data, and image semantics.
    /// </summary>
    private async Task EnsureHierarchyAsync(
        HierarchyRequest request,
        HttpContext http,
        CancellationToken ct)
    {
        var user = ResolveUser(http);
        if (user is null)
            return;

        if (request.ChildKind == BaseItemKind.Season
            && library.TryGetOwnedSeries(request.ParentId, out var series, out var tmdbId))
        {
            var allowsSeasons = HierarchyAllowsKind(http.Request.Query, BaseItemKind.Season);
            var expandEpisodes = request.SupportsRecursive
                                 && HierarchyAllowsRecursiveEpisodes(http.Request.Query);
            if (series is null
                || !CanExposeToUser(series, isTv: true, user)
                || (!allowsSeasons && !expandEpisodes))
            {
                return;
            }

            if (!library.IsHierarchyComplete(request.ParentId, BaseItemKind.Season))
            {
                using var hierarchyLoad = hierarchyLoads.Acquire(
                        new HierarchyLoadCoordinator.Key(tmdbId, null),
                        HierarchyTimeout,
                        loadToken => api.GetTvSeriesAsync(tmdbId, loadToken));
                // The keyed lease is acquired before rechecking completeness and retained through
                // marker commit, so a later cold caller cannot slip in and duplicate the fetch.
                if (!library.IsHierarchyComplete(request.ParentId, BaseItemKind.Season))
                {
                    var details = await hierarchyLoad.FetchAsync(ct).ConfigureAwait(false);
                    if (details is not null
                        && !library.IsHierarchyComplete(request.ParentId, BaseItemKind.Season))
                    {
                        await library.MaterializeSeasonsAsync(details, ct).ConfigureAwait(false);
                    }
                }
            }

            if (expandEpisodes)
            {
                using var seriesReservation = library.ReserveSeriesHierarchy(request.ParentId);
                if (!library.CanExpandCompleteSeriesHierarchy(request.ParentId))
                {
                    logger.LogDebug(
                        "Skipping recursive episode expansion for TMDB series {TmdbId}: the complete hierarchy cannot be represented within the ephemeral capacity",
                        tmdbId);
                    return;
                }

                await ExpandRecursiveEpisodesAsync(request.ParentId, tmdbId, ct).ConfigureAwait(false);
            }
            return;
        }

        if (request.ChildKind == BaseItemKind.Episode
            && library.TryGetOwnedSeason(
                request.ParentId,
                out var season,
                out var parentSeries,
                out var episodeTmdbId,
                out var seasonNumber))
        {
            if (season is null
                || parentSeries is null
                || (request.ExpectedSeriesId is { } expectedSeriesId && parentSeries.Id != expectedSeriesId)
                || !CanExposeToUser(season, isTv: true, user)
                || !HierarchyAllowsKind(http.Request.Query, BaseItemKind.Episode))
            {
                return;
            }

            if (library.IsHierarchyComplete(request.ParentId, BaseItemKind.Episode))
                return;

            await EnsureEpisodesAsync(
                    parentSeries.Id,
                    request.ParentId,
                    episodeTmdbId,
                    seasonNumber,
                    ct)
                .ConfigureAwait(false);
            return;
        }

        // Jellyfin's /Shows/{seriesId}/Episodes route may identify the season by number rather
        // than seasonId. The episode response itself contains enough metadata to materialize the
        // missing season shell, so no separate indexer request is introduced.
        if (request.ChildKind == BaseItemKind.Episode
            && request.SeasonNumber is { } requestedSeason
            && library.TryGetOwnedSeries(request.ParentId, out var routeSeries, out var routeTmdbId))
        {
            if (routeSeries is null
                || requestedSeason < 0
                || !CanExposeToUser(routeSeries, isTv: true, user)
                || !HierarchyAllowsKind(http.Request.Query, BaseItemKind.Episode))
            {
                return;
            }

            if (library.TryFindOwnedSeason(request.ParentId, requestedSeason, out var existingSeason)
                && existingSeason is not null
                && library.IsHierarchyComplete(existingSeason.Id, BaseItemKind.Episode))
            {
                return;
            }

            await EnsureEpisodesAsync(request.ParentId, null, routeTmdbId, requestedSeason, ct).ConfigureAwait(false);
        }
    }

    private async Task EnsureEpisodesAsync(
        Guid seriesId,
        Guid? knownSeasonId,
        int tmdbId,
        int seasonNumber,
        CancellationToken ct,
        bool protectSeriesHierarchy = false)
    {
        using var hierarchyLoad = hierarchyLoads.Acquire(
            new HierarchyLoadCoordinator.Key(tmdbId, seasonNumber),
            HierarchyTimeout,
            loadToken => api.GetTvSeasonAsync(tmdbId, seasonNumber, loadToken));

        var seasonId = knownSeasonId;
        if (seasonId is null
            && library.TryFindOwnedSeason(seriesId, seasonNumber, out var materializedSeason))
        {
            seasonId = materializedSeason?.Id;
        }

        if (seasonId is { } completeSeasonId
            && library.IsHierarchyComplete(completeSeasonId, BaseItemKind.Episode))
        {
            return;
        }

        // Only the Core/indexer fetch is shared. Direct and recursive callers subsequently enter
        // the library's materialization gate with their own capacity-protection policy. The lease
        // remains active through that commit, so a third caller can reuse the completed response.
        var details = await hierarchyLoad.FetchAsync(ct).ConfigureAwait(false);
        if (details is not null)
        {
            await library
                .MaterializeEpisodesAsync(details, ct, protectSeriesHierarchy)
                .ConfigureAwait(false);
        }
    }

    private async Task ExpandRecursiveEpisodesAsync(Guid seriesId, int tmdbId, CancellationToken ct)
    {
        var incompleteSeasons = library.GetOwnedSeasons(seriesId)
            .Where(season => season.IndexNumber is >= 0
                             && !library.IsHierarchyComplete(season.Id, BaseItemKind.Episode))
            .ToArray();
        await Parallel.ForEachAsync(
                incompleteSeasons,
                new ParallelOptions
                {
                    CancellationToken = ct,
                    MaxDegreeOfParallelism = MaxRecursiveSeasonConcurrency,
                },
                async (season, seasonToken) =>
                {
                    try
                    {
                        await EnsureEpisodesAsync(
                                seriesId,
                                season.Id,
                                tmdbId,
                                season.IndexNumber!.Value,
                                seasonToken,
                                protectSeriesHierarchy: true)
                            .ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (seasonToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        logger.LogDebug(
                            "Could not recursively populate TMDB series {TmdbId} season {Season} ({FailureType})",
                            tmdbId,
                            season.IndexNumber,
                            ex.GetType().Name);
                    }
                })
            .ConfigureAwait(false);
    }

    internal static bool HierarchyAllowsKind(IQueryCollection query, BaseItemKind kind)
    {
        if (!TryParseEnums(query, "includeItemTypes", out HashSet<BaseItemKind> included)
            || !TryParseEnums(query, "excludeItemTypes", out HashSet<BaseItemKind> excluded)
            || !TryParseEnums(query, "mediaTypes", out HashSet<MediaType> mediaTypes))
        {
            return false;
        }

        return (included.Count == 0 || included.Contains(kind))
               && !excluded.Contains(kind)
               && (mediaTypes.Count == 0 || mediaTypes.Contains(MediaType.Video));
    }

    internal static bool HierarchyAllowsRecursiveEpisodes(IQueryCollection query)
        => query.TryGetValue("recursive", out var recursiveValue)
           && recursiveValue.Count == 1
           && TryBool(recursiveValue.ToString(), out var recursive)
           && recursive
           && HierarchyAllowsKind(query, BaseItemKind.Episode);

    private static string? GetSearchTerm(HttpRequest request)
    {
        if (!request.Query.TryGetValue(SearchTermKey, out var value))
            return null;
        if (value.Count != 1)
            return null;
        var term = value.ToString().Trim();
        return term.Length is > 0 and <= MaxSearchTermLength && !term.Any(char.IsControl) ? term : null;
    }

    private static bool TryParentId(HttpRequest request, out Guid parentId)
    {
        parentId = Guid.Empty;
        return request.Query.TryGetValue("parentId", out var value)
               && value.Count == 1
               && TryGuid(value.ToString(), out parentId)
               && parentId != Guid.Empty;
    }

    private BaseItemKind? OwnedChildKind(Guid parentId)
    {
        if (library.TryGetOwnedSeries(parentId, out _, out _))
            return BaseItemKind.Season;
        if (library.TryGetOwnedSeason(parentId, out _, out _, out _, out _))
            return BaseItemKind.Episode;
        return null;
    }

    private bool TryGetHierarchyRequest(ActionExecutingContext context, out HierarchyRequest request)
    {
        if (TryGetShowHierarchyRequest(context, out request))
            return true;

        var httpRequest = context.HttpContext.Request;
        request = new HierarchyRequest(Guid.Empty, BaseItemKind.Folder, null, null, false);
        if (!IsSupportedSearchPath(httpRequest.Path, isHintRequest: false)
            || !TryParentId(httpRequest, out var parentId)
            || OwnedChildKind(parentId) is not { } kind)
        {
            return false;
        }

        request = new HierarchyRequest(parentId, kind, null, null, true);
        return true;
    }

    private static bool TryGetShowHierarchyRequest(
        ActionExecutingContext context,
        out HierarchyRequest request)
    {
        request = new HierarchyRequest(Guid.Empty, BaseItemKind.Folder, null, null, false);
        var parts = (context.HttpContext.Request.Path.Value ?? string.Empty)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (!IsSupportedHierarchyPath(context.HttpContext.Request.Path)
            || !TryGuid(parts[1], out var seriesId))
        {
            return false;
        }

        if (string.Equals(parts[2], "Seasons", StringComparison.OrdinalIgnoreCase))
        {
            request = new HierarchyRequest(seriesId, BaseItemKind.Season, null, seriesId, false);
            return true;
        }

        if (!string.Equals(parts[2], "Episodes", StringComparison.OrdinalIgnoreCase))
            return false;

        var query = context.HttpContext.Request.Query;
        if (query.TryGetValue("seasonId", out var seasonIdValue))
        {
            if (seasonIdValue.Count != 1
                || !TryGuid(seasonIdValue.ToString(), out var seasonId)
                || seasonId == Guid.Empty)
            {
                return false;
            }

            request = new HierarchyRequest(seasonId, BaseItemKind.Episode, null, seriesId, false);
            return true;
        }

        if (!query.TryGetValue("season", out var seasonValue)
            || seasonValue.Count != 1
            || !TryInt(seasonValue.ToString(), out var seasonNumber)
            || seasonNumber < 0)
        {
            return false;
        }

        request = new HierarchyRequest(seriesId, BaseItemKind.Episode, seasonNumber, seriesId, false);
        return true;
    }

    internal static bool IsSupportedHierarchyPath(PathString path)
    {
        var parts = (path.Value ?? string.Empty)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 3
               && string.Equals(parts[0], "Shows", StringComparison.OrdinalIgnoreCase)
               && TryGuid(parts[1], out var seriesId)
               && seriesId != Guid.Empty
               && (string.Equals(parts[2], "Seasons", StringComparison.OrdinalIgnoreCase)
                   || string.Equals(parts[2], "Episodes", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Resolves the exact authenticated/target Jellyfin user. Never falls back to another account:
    /// doing so would apply the wrong library and parental-control policy to injected results.
    /// </summary>
    private User? ResolveUser(HttpContext http)
    {
        try
        {
            const string userIdClaimType = "Jellyfin-UserId";
            var claim = http.User?.Claims.FirstOrDefault(c =>
                string.Equals(c.Type, userIdClaimType, StringComparison.Ordinal));
            if (claim is null || !Guid.TryParse(claim.Value, out var authenticatedId) || authenticatedId == Guid.Empty)
                return null;

            var targetId = authenticatedId;
            if (TryGuid(http.Request.Query["userId"].ToString(), out var requestedId)
                && requestedId != Guid.Empty)
            {
                if (requestedId != authenticatedId && !(http.User?.IsInRole("Administrator") ?? false))
                    return null;
                targetId = requestedId;
            }

            return userManager.GetUserById(targetId);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not resolve a Jellyfin user for DTO building");
            return null;
        }
    }

    private static bool CanExposeToUser(BaseItem item, bool isTv, User user)
    {
        if (!item.IsVisible(user))
            return false;

        // A synthetic item is only offered when the requesting user can see at least
        // one compatible Jellyfin library. This mirrors folder restrictions without attaching
        // the private Streamarr folder to any normal library view.
        return StreamarrItemVisibility.HasCompatibleLibrary(user, episode: isTv);
    }

    private string? ImageTag(BaseItem item, ImageType imageType)
    {
        try
        {
            var image = item.GetImageInfo(imageType, 0);
            return image is null ? null : imageProcessor.GetImageCacheTag(item, image);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not build {ImageType} tag for ephemeral item {ItemId}", imageType, item.Id);
            return null;
        }
    }

    internal static SearchInjection.Constraints GetConstraints(HttpRequest request, bool isHintRequest)
    {
        var query = request.Query;
        var valid = true;

        var startIndex = 0;
        if (query.ContainsKey("startIndex")
            && (!TryInt(query["startIndex"].ToString(), out startIndex) || startIndex < 0))
        {
            valid = false;
        }

        int? limit = null;
        if (query.ContainsKey("limit"))
        {
            if (TryInt(query["limit"].ToString(), out var parsedLimit) && parsedLimit >= 0)
                limit = parsedLimit;
            else
                valid = false;
        }

        Guid? parentId = null;
        if (query.ContainsKey("parentId"))
        {
            if (TryGuid(query["parentId"].ToString(), out var parsedParent))
                parentId = parsedParent;
            else
                valid = false;
        }

        if (query.ContainsKey("userId")
            && (!TryGuid(query["userId"].ToString(), out var userId) || userId == Guid.Empty))
        {
            valid = false;
        }

        valid &= TryParseEnums(query, "includeItemTypes", out HashSet<BaseItemKind> includeItemTypes);
        valid &= TryParseEnums(query, "excludeItemTypes", out HashSet<BaseItemKind> excludeItemTypes);
        valid &= TryParseEnums(query, "mediaTypes", out HashSet<MediaType> mediaTypes);

        var includeMedia = true;
        if (isHintRequest && query.ContainsKey("includeMedia")
            && !TryBool(query["includeMedia"].ToString(), out includeMedia))
        {
            valid = false;
        }

        bool? isMovie = null;
        if (query.ContainsKey("isMovie"))
        {
            if (TryBool(query["isMovie"].ToString(), out var parsed))
                isMovie = parsed;
            else
                valid = false;
        }

        bool? isSeries = null;
        if (query.ContainsKey("isSeries"))
        {
            if (TryBool(query["isSeries"].ToString(), out var parsed))
                isSeries = parsed;
            else
                valid = false;
        }

        if (query.ContainsKey("recursive")
            && (!TryBool(query["recursive"].ToString(), out var recursive) || !recursive))
        {
            valid = false;
        }

        // Any unrecognized query option may be a native predicate or sort we cannot faithfully
        // apply after Jellyfin has produced its page. Fail closed rather than broadening it.
        HashSet<string> supportedKeys = new(
        [
            "searchTerm", "userId", "startIndex", "limit", "parentId", "includeItemTypes",
            "excludeItemTypes", "mediaTypes", "includeMedia", "isMovie", "isSeries", "recursive",
            "fields", "enableUserData", "imageTypeLimit", "enableImageTypes", "enableImages",
            "enableTotalRecordCount", "includePeople", "includeGenres", "includeStudios",
            "includeArtists", "api_key",
        ], StringComparer.OrdinalIgnoreCase);
        if (query.Keys.Any(key => !supportedKeys.Contains(key)))
            valid = false;

        return new SearchInjection.Constraints(
            startIndex,
            limit,
            parentId,
            includeItemTypes,
            excludeItemTypes,
            mediaTypes,
            includeMedia,
            isMovie,
            isSeries,
            valid);
    }

    internal static bool IsSupportedSearchPath(PathString path, bool isHintRequest)
        => string.Equals(
            path.Value,
            isHintRequest ? "/Search/Hints" : "/Items",
            StringComparison.OrdinalIgnoreCase);

    private static bool TryParseEnums<TEnum>(
        IQueryCollection query,
        string key,
        out HashSet<TEnum> parsed)
        where TEnum : struct, Enum
    {
        parsed = [];
        if (!query.ContainsKey(key))
            return true;

        var value = query[key].ToString();
        if (string.IsNullOrWhiteSpace(value))
            return false;

        foreach (var part in value.Split(',', StringSplitOptions.TrimEntries))
        {
            if (part.Length == 0)
                return false;
            if (!Enum.TryParse<TEnum>(part, true, out var item)
                || !Enum.IsDefined(item)
                || !string.Equals(Enum.GetName(item), part, StringComparison.OrdinalIgnoreCase))
                return false;
            parsed.Add(item);
        }

        return parsed.Count > 0;
    }

    private static bool TryInt(string value, out int parsed)
        => int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out parsed);

    private static bool TryGuid(string value, out Guid parsed) => Guid.TryParse(value, out parsed);

    private static bool TryBool(string value, out bool parsed) => bool.TryParse(value, out parsed);
}
