using System.Net.Http.Headers;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Downloads;

/// <summary>
/// ⚠️ KNOWN-FRAGILE — binds to Jellyfin's built-in <c>GET /Items/{itemId}/Download</c> route
/// (<c>Jellyfin.Api.Controllers.LibraryController.GetDownload</c>). That handler requires
/// <c>item.Path</c> to be a real local file — <c>Video.CanDownload()</c> returns
/// <c>IsFileProtocol</c>, and the body streams the path through <c>PhysicalFile</c> — which
/// Streamarr items can never satisfy: they are pathless and resolved lazily through
/// <see cref="IMediaSourceProvider"/> (BRIEF §8.4). Native Jellyfin therefore hides the
/// Download action for every Streamarr-owned item and 400s if it is invoked directly.
/// <para>
/// This filter answers the exact same route with a full-speed proxy of the Core Server's
/// unpaced download capability (<c>GET /api/v1/download/{token}</c> — see
/// <c>DownloadController</c>/<c>StreamPacer</c> on Core), so every native and third-party
/// Jellyfin client that calls the standard download endpoint is covered without any
/// client-specific code — no redirect to Core, no special client handling.
/// </para>
/// <para>
/// Runs as an MVC action filter, which executes strictly after Jellyfin's own
/// <c>[Authorize(Policy = Policies.Download)]</c> check (an authorization filter, earlier in
/// the ASP.NET Core pipeline), so the per-user "Allow media downloading" permission is still
/// fully enforced by Jellyfin itself before this code ever runs. Only short-circuits the
/// action body for items this plugin owns; every other item (ordinary local library content)
/// falls through to Jellyfin's native handler completely untouched, exactly like
/// <see cref="Search.StreamarrSearchActionFilter"/>.
/// </para>
/// </summary>
public sealed class StreamarrDownloadActionFilter(
    StreamarrMediaSourceProjection projection,
    StreamarrMediaSourceProvider mediaSourceProvider,
    StreamarrApiClient api,
    ILibraryManager libraryManager,
    IUserManager userManager,
    ILogger<StreamarrDownloadActionFilter> logger) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (!TryGetDownloadItemId(context.HttpContext.Request.Path, out var itemId)
            || !projection.Owns(itemId))
        {
            var executed = await next().ConfigureAwait(false);
            try
            {
                if (executed.Result is ObjectResult { Value: { } value })
                    ApplyCanDownloadPresentation(value, context.HttpContext);
            }
            catch (Exception ex)
            {
                // Never let this cosmetic fix-up break an otherwise-successful response.
                logger.LogDebug(
                    "Streamarr CanDownload fix-up failed ({FailureType})", ex.GetType().Name);
            }

            return;
        }

        var http = context.HttpContext;
        var ct = http.RequestAborted;
        try
        {
            await ServeDownloadAsync(itemId, http, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Client disconnected mid-download; nothing left to respond with.
        }
        catch (DownloadUnavailableException ex)
        {
            if (!http.Response.HasStarted)
            {
                context.Result = new StatusCodeResult(ex.StatusCode);
                return;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Streamarr download proxy failed for item {ItemId} ({FailureType})",
                itemId,
                ex.GetType().Name);
            if (!http.Response.HasStarted)
            {
                context.Result = new StatusCodeResult(StatusCodes.Status502BadGateway);
                return;
            }
        }

        // The response was already written directly to HttpContext.Response (or the
        // connection is gone); no further MVC result should run either way.
        context.Result = new EmptyResult();
    }

    /// <summary>
    /// Resolves the top-ranked release exactly as Jellyfin's own PlaybackInfo flow would
    /// (<see cref="StreamarrMediaSourceProvider"/> owns ranking/fallback/tracking — no
    /// duplicated domain logic here), opens it, and proxies the Core Server's unpaced
    /// download capability straight into the Jellyfin response body.
    /// </summary>
    private async Task ServeDownloadAsync(Guid itemId, HttpContext http, CancellationToken ct)
    {
        var item = libraryManager.GetItemById(itemId)
            ?? throw new DownloadUnavailableException(StatusCodes.Status404NotFound);

        var sources = await mediaSourceProvider.GetMediaSources(item, ct).ConfigureAwait(false);
        var top = sources.FirstOrDefault(source => !string.IsNullOrEmpty(source.OpenToken));
        if (top?.OpenToken is not { } openToken)
            throw new DownloadUnavailableException(StatusCodes.Status404NotFound);

        var liveStreams = new List<ILiveStream>();
        var liveStream = await mediaSourceProvider.OpenMediaSource(openToken, liveStreams, ct)
            .ConfigureAwait(false);
        var token = StreamarrApiClient.TokenFromStreamUrl(liveStream.MediaSource.Path);
        try
        {
            if (token is null)
                throw new DownloadUnavailableException(StatusCodes.Status502BadGateway);

            var range = http.Request.Headers.TryGetValue("Range", out var rangeValues)
                ? rangeValues.ToString()
                : null;
            using var upstream = await api.OpenDownloadAsync(token, range, ct).ConfigureAwait(false);
            if (!upstream.IsSuccessStatusCode)
                throw new DownloadUnavailableException((int)upstream.StatusCode);

            var response = http.Response;
            response.StatusCode = (int)upstream.StatusCode;
            CopyHeader(upstream.Content.Headers, "Content-Type", response);
            CopyHeader(upstream.Content.Headers, "Content-Length", response);
            CopyHeader(upstream.Content.Headers, "Content-Disposition", response);
            CopyHeader(upstream.Content.Headers, "Content-Range", response);
            CopyHeader(upstream.Headers, "Accept-Ranges", response);

            await using var body = await upstream.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await body.CopyToAsync(response.Body, ct).ConfigureAwait(false);
        }
        finally
        {
            await liveStream.Close().ConfigureAwait(false);
            if (token is not null)
            {
                // Best-effort: free Core's NNTP connections/session immediately instead of
                // waiting for TTL, whether the download finished, failed, or was cancelled.
                using var closeDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try
                {
                    await api.CloseSessionAsync(token, closeDeadline.Token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogDebug(
                        "Could not close the Core session opened for a download ({FailureType})",
                        ex.GetType().Name);
                }
            }
        }
    }

    /// <summary>
    /// Jellyfin's <c>DtoService</c> computes <c>BaseItemDto.CanDownload</c> from
    /// <c>Video.CanDownload(user)</c>, which is <c>IsFileProtocol &amp;&amp;
    /// user.HasPermission(EnableContentDownloading)</c> — always false for pathless Streamarr
    /// items regardless of the user's actual download permission. Every native and third-party
    /// client (Jellyfin Web, Swiftfin, Infuse, …) reads this flag to decide whether to render a
    /// Download action at all, so the endpoint working is not enough on its own — the flag must
    /// agree, or nobody ever sees the button. Corrects it to mirror exactly what
    /// <see cref="ServeDownloadAsync"/> will actually allow: owned item, same permission check.
    /// </summary>
    private void ApplyCanDownloadPresentation(object value, HttpContext http)
    {
        switch (value)
        {
            case BaseItemDto dto:
                FixUpCanDownload(dto, http);
                break;
            case QueryResult<BaseItemDto> result:
                foreach (var dto in result.Items)
                    FixUpCanDownload(dto, http);
                break;
        }
    }

    private void FixUpCanDownload(BaseItemDto? dto, HttpContext http)
    {
        if (dto is null || dto.Id == Guid.Empty || dto.CanDownload == true || !projection.Owns(dto.Id))
            return;

        var user = ResolveUser(http);
        if (user is not null && user.HasPermission(PermissionKind.EnableContentDownloading))
            dto.CanDownload = true;
    }

    /// <summary>Reads the authenticated caller's id claim, matching <c>StreamarrMediaSourceProvider.CurrentUserId</c>.</summary>
    private User? ResolveUser(HttpContext http)
    {
        const string userIdClaimType = "Jellyfin-UserId";
        var claim = http.User?.Claims.FirstOrDefault(candidate =>
            string.Equals(candidate.Type, userIdClaimType, StringComparison.Ordinal));
        return claim is not null && Guid.TryParse(claim.Value, out var userId)
            ? userManager.GetUserById(userId)
            : null;
    }

    private static void CopyHeader(HttpHeaders source, string name, HttpResponse response)
    {
        if (source.TryGetValues(name, out var values))
            response.Headers[name] = values.ToArray();
    }

    /// <summary>Matches Jellyfin's <c>GET /Items/{itemId}/Download</c> route exactly.</summary>
    internal static bool TryGetDownloadItemId(PathString path, out Guid itemId)
    {
        itemId = Guid.Empty;
        var parts = (path.Value ?? string.Empty)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 3
               && string.Equals(parts[0], "Items", StringComparison.OrdinalIgnoreCase)
               && string.Equals(parts[2], "Download", StringComparison.OrdinalIgnoreCase)
               && Guid.TryParse(parts[1], out itemId)
               && itemId != Guid.Empty;
    }

    private sealed class DownloadUnavailableException(int statusCode) : Exception
    {
        public int StatusCode { get; } = statusCode;
    }
}
