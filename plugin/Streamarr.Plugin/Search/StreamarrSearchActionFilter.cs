using System.Security.Claims;
using Jellyfin.Data.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
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
    IUserManager userManager,
    ILibraryManager libraryManager,
    ILogger<StreamarrSearchActionFilter> logger) : IAsyncActionFilter
{
    /// <summary>Search must never stall a keystroke: a slow Core Server is treated as absent.</summary>
    private static readonly TimeSpan InterceptTimeout = TimeSpan.FromSeconds(4);

    /// <summary>Upper bound on works materialized per search, to bound request cost.</summary>
    private const int MaxWorks = 20;

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
                    obj.Value = await InjectHintsAsync(hints, term, ct).ConfigureAwait(false);
                    break;
            }
        }
        catch (Exception ex)
        {
            // Non-negotiable: interception failure degrades to native results (BRIEF §11).
            logger.LogWarning(ex, "Streamarr search interception failed; returning native results unchanged");
        }
    }

    private async Task<QueryResult<BaseItemDto>> InjectItemsAsync(
        QueryResult<BaseItemDto> native,
        string term,
        HttpContext http,
        CancellationToken ct)
    {
        var works = await FetchWorksAsync(term, ct).ConfigureAwait(false);
        if (works.Count == 0)
            return native;

        var user = ResolveUser(http);
        var dtoOptions = new DtoOptions(true) { EnableUserData = user is not null };

        var injected = new List<BaseItemDto>(works.Count);
        foreach (var work in works)
        {
            try
            {
                var itemId = await library.MaterializeAsync(work, ct).ConfigureAwait(false);
                if (libraryManager.GetItemById(itemId) is not { } item)
                    continue;
                injected.Add(dtoService.GetBaseItemDto(item, dtoOptions, user!, null!));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral work {WorkId} during item injection", work.WorkId);
            }
        }

        var merged = SearchInjection.MergeItems(native.Items, injected);
        var added = merged.Count - native.Items.Count;
        logger.LogDebug("Injected {Added} Streamarr work(s) into /Items search for '{Term}'", added, term);
        return new QueryResult<BaseItemDto>(native.StartIndex, native.TotalRecordCount + added, merged);
    }

    private async Task<SearchHintResult> InjectHintsAsync(
        SearchHintResult native,
        string term,
        CancellationToken ct)
    {
        var works = await FetchWorksAsync(term, ct).ConfigureAwait(false);
        if (works.Count == 0)
            return native;

        var injected = new List<SearchHint>(works.Count);
        foreach (var work in works)
        {
            try
            {
                var itemId = await library.MaterializeAsync(work, ct).ConfigureAwait(false);
                injected.Add(SearchInjection.BuildHint(itemId, work));
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipping ephemeral work {WorkId} during hint injection", work.WorkId);
            }
        }

        var merged = SearchInjection.MergeHints(native.SearchHints, injected);
        var added = merged.Count - native.SearchHints.Count;
        logger.LogDebug("Injected {Added} Streamarr hint(s) into /Search/Hints for '{Term}'", added, term);
        return new SearchHintResult(merged, native.TotalRecordCount + added);
    }

    /// <summary>
    /// Calls <c>GET /api/v1/search</c> under a short deadline. Any failure/timeout returns an
    /// empty list so the caller falls through to native results untouched.
    /// </summary>
    private async Task<IReadOnlyList<WorkDto>> FetchWorksAsync(string term, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(InterceptTimeout);
            var response = await api.SearchAsync(term, cts.Token).ConfigureAwait(false);
            return response?.Results
                       .Where(w => w.Releases.Count > 0)
                       .Take(MaxWorks)
                       .ToList()
                   ?? [];
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Core Server search unavailable for '{Term}'; leaving native results intact", term);
            return [];
        }
    }

    private static string? GetSearchTerm(HttpRequest request)
        => request.Query.TryGetValue(SearchTermKey, out var value) ? value.ToString() : null;

    /// <summary>
    /// Best-effort resolution of the requesting Jellyfin user (for DTO user-data), falling back to
    /// the first user and finally to <c>null</c>. Never throws — DTO building tolerates a null user
    /// because we disable user-data when it is absent.
    /// </summary>
    private User? ResolveUser(HttpContext http)
    {
        try
        {
            foreach (var claim in http.User?.Claims ?? Enumerable.Empty<Claim>())
            {
                if (Guid.TryParse(claim.Value, out var id) && userManager.GetUserById(id) is { } user)
                    return user;
            }

            return userManager.Users.FirstOrDefault();
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Could not resolve a Jellyfin user for DTO building");
            return null;
        }
    }
}
