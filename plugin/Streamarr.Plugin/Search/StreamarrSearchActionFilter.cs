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
/// <item>the <c>/Items</c> action returning <see cref="QueryResult{BaseItemDto}"/> and
/// <c>/Search/Hints</c> returning <see cref="SearchHintResult"/> (we dispatch on the response
/// value type, not the route string, so a route rename does not break us);</item>
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
    IDtoService dtoService,
    IImageProcessor imageProcessor,
    IUserManager userManager,
    ILibraryManager libraryManager,
    ILogger<StreamarrSearchActionFilter> logger) : IAsyncActionFilter
{
    /// <summary>Search must never stall a keystroke: a slow Core Server is treated as absent.</summary>
    private static readonly TimeSpan InterceptTimeout = TimeSpan.FromSeconds(4);

    /// <summary>Upper bound on works materialized per search, to bound request cost.</summary>
    private const int MaxWorks = 20;
    private const int MaxSearchTermLength = 256;

    private const string SearchTermKey = "searchTerm";

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        // Let Jellyfin produce its native result first, then (best-effort) augment it. Native
        // behavior has already happened by this point, so we can only ever add to it.
        var executed = await next().ConfigureAwait(false);

        try
        {
            var config = Plugin.Instance?.Configuration;
            if (config is null || !config.InterceptionEnabled)
                return;

            if (executed.Result is not ObjectResult obj || obj.Value is null)
                return;

            var term = GetSearchTerm(context.HttpContext.Request);
            if (string.IsNullOrWhiteSpace(term))
                return;

            var ct = context.HttpContext.RequestAborted;
            switch (obj.Value)
            {
                case QueryResult<BaseItemDto> items:
                    obj.Value = await InjectItemsAsync(items, term, context.HttpContext, ct).ConfigureAwait(false);
                    break;
                case SearchHintResult hints:
                    obj.Value = await InjectHintsAsync(hints, term, context.HttpContext, ct).ConfigureAwait(false);
                    break;
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

        var works = await FetchWorksAsync(term, constraints, ct).ConfigureAwait(false);
        if (works.Count == 0)
            return native;

        var dtoOptions = new DtoOptions(true) { EnableUserData = true };

        var injected = new List<BaseItemDto>(Math.Min(works.Count, capacity));
        foreach (var work in works)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeAsync(work, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item)
                    continue;
                if (!CanExposeToUser(item, work, user))
                    continue;
                injected.Add(dtoService.GetBaseItemDto(item, dtoOptions, user, null!));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral work {WorkId} during item injection", work.WorkId);
            }
        }

        var merged = SearchInjection.MergeItems(native.Items, injected);
        var added = merged.Count - native.Items.Count;
        logger.LogDebug("Injected {Added} Streamarr work(s) into an /Items search", added);
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

        var works = await FetchWorksAsync(term, constraints, ct).ConfigureAwait(false);
        if (works.Count == 0)
            return native;

        var injected = new List<SearchHint>(Math.Min(works.Count, capacity));
        foreach (var work in works)
        {
            if (injected.Count >= capacity)
                break;

            try
            {
                var itemId = await library.MaterializeAsync(work, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item
                    || !CanExposeToUser(item, work, user))
                {
                    continue;
                }

                injected.Add(SearchInjection.BuildHint(
                    itemId,
                    work,
                    ImageTag(item, ImageType.Primary),
                    ImageTag(item, ImageType.Backdrop)));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral work {WorkId} during hint injection", work.WorkId);
            }
        }

        var merged = SearchInjection.MergeHints(native.SearchHints, injected);
        var added = merged.Count - native.SearchHints.Count;
        logger.LogDebug("Injected {Added} Streamarr hint(s) into /Search/Hints", added);
        return new SearchHintResult(merged, native.TotalRecordCount + added);
    }

    /// <summary>
    /// Calls <c>GET /api/v1/search</c> under a short deadline. Any failure/timeout returns an
    /// empty list so the caller falls through to native results untouched.
    /// </summary>
    private async Task<IReadOnlyList<WorkDto>> FetchWorksAsync(
        string term,
        SearchInjection.Constraints constraints,
        CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(InterceptTimeout);
            var response = await api.SearchAsync(term, constraints.CoreMediaType, cts.Token).ConfigureAwait(false);
            return response?.Results
                       .Where(w => w.Releases.Count > 0)
                       .Where(constraints.Allows)
                       .Take(MaxWorks)
                       .ToList()
                   ?? [];
        }
        catch (Exception ex)
        {
            logger.LogDebug(
                "Core Server search unavailable ({FailureType}); leaving native results intact",
                ex.GetType().Name);
            return [];
        }
    }

    private static string? GetSearchTerm(HttpRequest request)
    {
        if (!request.Query.TryGetValue(SearchTermKey, out var value))
            return null;
        if (value.Count != 1)
            return null;
        var term = value.ToString().Trim();
        return term.Length is > 0 and <= MaxSearchTermLength && !term.Any(char.IsControl) ? term : null;
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

    private bool CanExposeToUser(BaseItem item, WorkDto work, User user)
    {
        if (!item.IsVisible(user))
            return false;

        // A synthetic movie/episode is only offered when the requesting user can see at least
        // one compatible Jellyfin library. This mirrors folder restrictions without attaching
        // the private Streamarr folder to any normal library view.
        var episode = SearchInjection.IsEpisode(work);
        return StreamarrItemVisibility.HasCompatibleLibrary(user, episode);
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
