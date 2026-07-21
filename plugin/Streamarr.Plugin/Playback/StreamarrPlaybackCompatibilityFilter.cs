using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// ⚠️ KNOWN-FRAGILE — version-sensitive coupling to Jellyfin's HTTP pipeline
/// (docs/jellyfin-compatibility.md). Compatibility shim for Swiftfin's playback setup.
/// <para>
/// Swiftfin only implements remote/live media sources for Live TV channels. For a movie or
/// episode backed by a Streamarr <c>RequiresOpening</c> source it requests
/// <c>/Videos/{itemId}/stream?static=true</c> — a URL the server cannot satisfy because the
/// bytes exist only behind an opened live stream (the shipped 1.x app never opens one, and no
/// Swiftfin version passes the live-stream id on the static route). Jellyfin Web works because
/// it cannot direct-play these containers and therefore receives a <c>TranscodingUrl</c> built
/// on the opened stream; this filter forces Swiftfin onto that same, working path by rewriting
/// its <c>POST /Items/{itemId}/PlaybackInfo</c> request to <c>AutoOpenLiveStream = true</c>,
/// <c>EnableDirectPlay = false</c>, and an empty <c>LiveStreamId</c>. The last override matters
/// when the rewritten Swiftfin player changes an audio/subtitle track: it stops the old item and
/// then sends that now-closed live-stream id while rebuilding playback. Ignoring the stale id
/// lets Jellyfin discover and open a fresh source with the requested track index. The result is
/// an HLS <b>remux</b> (ffmpeg stream-copy from the Core capability URL — no re-encode while the
/// codecs fit the client profile), so session open/close accounting continues to flow through
/// the provider unchanged.
/// </para>
/// <para>
/// Scope guards — every one must hold before the request is touched, so clients that implement
/// the Jellyfin protocol fully keep their native direct-play behavior:
/// <list type="bullet">
/// <item>the config toggle <c>SwiftfinCompatibilityEnabled</c> is on (default),</item>
/// <item>the action is exactly <c>POST /Items/{itemId}/PlaybackInfo</c>,</item>
/// <item>the authenticated device's <c>Jellyfin-Client</c> claim identifies Swiftfin
/// (it reports itself as <c>"Swiftfin iOS"</c> / <c>"Swiftfin tvOS"</c> / …),</item>
/// <item>the item is Streamarr-owned (backed by ephemeral release state).</item>
/// </list>
/// </para>
/// <para>
/// Version-sensitive contracts this file binds (verified against Jellyfin 10.11.11): the
/// PlaybackInfo POST route shape; <c>MediaInfoController.GetPostedPlaybackInfo</c> binding the
/// query parameters <c>liveStreamId</c> / <c>autoOpenLiveStream</c> /
/// <c>enableDirectPlay</c> with precedence over the posted body dto; and the
/// <c>Jellyfin-Client</c> auth claim. Any error or ABI drift falls through to the untouched
/// native action (BRIEF §11).
/// </para>
/// </summary>
public sealed class StreamarrPlaybackCompatibilityFilter(
    StreamarrMediaSourceProjection projection,
    ILogger<StreamarrPlaybackCompatibilityFilter> logger) : IAsyncActionFilter
{
    internal const string ClientClaimType = "Jellyfin-Client";
    internal const string LiveStreamArgument = "liveStreamId";
    internal const string AutoOpenArgument = "autoOpenLiveStream";
    internal const string EnableDirectPlayArgument = "enableDirectPlay";

    /// <summary>Clients that need the server-side open + remux path, matched by name prefix.</summary>
    private static readonly string[] AffectedClientPrefixes = ["Swiftfin"];

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        try
        {
            ApplyCompatibility(context);
        }
        catch (Exception ex)
        {
            // Non-negotiable: a broken shim must never break playback for anyone.
            logger.LogWarning(
                "Streamarr playback compatibility shim failed ({FailureType}); leaving the request untouched",
                ex.GetType().Name);
        }

        await next().ConfigureAwait(false);
    }

    private void ApplyCompatibility(ActionExecutingContext context)
    {
        // Plugin.Instance is unset only outside a real host (unit tests); a live Jellyfin
        // assigns it before MVC filters run. An explicit operator opt-out is the only "off".
        if (Plugin.Instance?.Configuration is { SwiftfinCompatibilityEnabled: false })
            return;

        var request = context.HttpContext.Request;
        if (!HttpMethods.IsPost(request.Method)
            || !TryGetPlaybackInfoItemId(request.Path, out var itemId)
            || !IsAffectedClient(context.HttpContext.User))
        {
            return;
        }

        if (!projection.Owns(itemId))
            return;

        // MediaInfoController reads these query-bound arguments with precedence over the posted
        // PlaybackInfoDto body ("Query having higher precedence"), so overriding them rewrites
        // the effective request without referencing Jellyfin.Api types the plugin does not
        // compile against. Drift guard: the action must still *declare* all three parameters —
        // the bound-argument dictionary cannot be used for this, because MVC may omit optional
        // query parameters the client did not send.
        var parameters = context.ActionDescriptor?.Parameters;
        if (parameters is null
            || !DeclaresParameter(parameters, LiveStreamArgument)
            || !DeclaresParameter(parameters, AutoOpenArgument)
            || !DeclaresParameter(parameters, EnableDirectPlayArgument))
        {
            logger.LogWarning(
                "PlaybackInfo no longer declares '{LiveStream}'/'{AutoOpen}'/'{DirectPlay}'; skipping the Swiftfin compatibility shim (see docs/jellyfin-compatibility.md)",
                LiveStreamArgument,
                AutoOpenArgument,
                EnableDirectPlayArgument);
            return;
        }

        // Swiftfin's track-change rebuild stops its current HLS item before posting PlaybackInfo
        // with that item's LiveStreamId. Jellyfin has already removed the stream, so honoring the
        // body value makes GetPlaybackInfo look up a dead id and fail with a 500. Empty (rather
        // than null) deliberately wins the controller's `liveStreamId ??= dto.LiveStreamId`
        // merge, taking the normal projection + AutoOpen path and preserving AudioStreamIndex.
        context.ActionArguments[LiveStreamArgument] = string.Empty;
        context.ActionArguments[AutoOpenArgument] = (bool?)true;
        context.ActionArguments[EnableDirectPlayArgument] = (bool?)false;
        logger.LogDebug(
            "Rewrote a Swiftfin PlaybackInfo request for Streamarr item {ItemId}: opening a fresh live stream and forcing a remux transcoding offer",
            itemId);
    }

    private static bool DeclaresParameter(IEnumerable<ParameterDescriptor> parameters, string name)
        => parameters.Any(parameter => string.Equals(parameter.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Matches exactly <c>/Items/{itemId}/PlaybackInfo</c> — the only action this shim rewrites.</summary>
    internal static bool TryGetPlaybackInfoItemId(PathString path, out Guid itemId)
    {
        itemId = Guid.Empty;
        var parts = (path.Value ?? string.Empty)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 3
               && string.Equals(parts[0], "Items", StringComparison.OrdinalIgnoreCase)
               && string.Equals(parts[2], "PlaybackInfo", StringComparison.OrdinalIgnoreCase)
               && Guid.TryParse(parts[1], out itemId)
               && itemId != Guid.Empty;
    }

    /// <summary>
    /// True only for clients that need the shim. Swiftfin reports itself as
    /// <c>"Swiftfin \(platform)"</c> (JellyfinClient.swift), e.g. "Swiftfin iOS", "Swiftfin tvOS".
    /// </summary>
    internal static bool IsAffectedClient(ClaimsPrincipal? user)
    {
        var client = user?.Claims.FirstOrDefault(claim =>
            string.Equals(claim.Type, ClientClaimType, StringComparison.Ordinal))?.Value;
        if (string.IsNullOrWhiteSpace(client))
            return false;

        var trimmed = client.TrimStart();
        return AffectedClientPrefixes.Any(prefix =>
            trimmed.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
}
