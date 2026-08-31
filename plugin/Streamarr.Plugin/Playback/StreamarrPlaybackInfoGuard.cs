using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dlna;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.MediaSources;

namespace Streamarr.Plugin.Playback;

/// <summary>
/// ⚠️ KNOWN-FRAGILE — version-sensitive coupling to Jellyfin's HTTP pipeline
/// (docs/jellyfin-compatibility.md). Client-agnostic request hardening for
/// <c>POST /Items/{itemId}/PlaybackInfo</c> on Streamarr-owned items.
/// <para>
/// Streamarr live streams close aggressively (every stop, track change, or source switch ends
/// the open), and several players — Swiftfin's rebuilt player among them — resend the previous
/// source's <c>LiveStreamId</c> when they reconstruct playback. Jellyfin resolves a supplied
/// live-stream id before anything else (<c>MediaInfoHelper.GetPlaybackInfo</c> →
/// <c>GetLiveStream</c>), so an id that is no longer open fails the whole request instead of
/// falling back to source discovery. This filter checks the referenced id against the host's
/// open-stream registry and clears it only when Jellyfin no longer knows it, letting discovery
/// and the client's own <c>AutoOpenLiveStream</c> open a fresh stream. A still-open id is never
/// touched, so clients legitimately reusing an open stream keep it (no duplicate sessions).
/// </para>
/// <para>
/// It additionally defaults <c>AutoOpenLiveStream</c> to <c>true</c> when the request expresses
/// no opening preference at all: every Streamarr source requires opening, so playback info
/// without an opened stream is unplayable for clients that never call
/// <c>/LiveStreams/Open</c> themselves (pre-rewrite Swiftfin 1.x). An explicit
/// <c>false</c> from a client that intends the two-step open flow is always honored.
/// </para>
/// <para>
/// It finally normalizes whitespace inside the comma-separated codec/container lists of a
/// posted <see cref="DeviceProfile"/> (here and on <c>POST /LiveStreams/Open</c>). Jellyfin
/// splits these lists without trimming, and its HLS codec filter
/// (<c>StreamBuilder.BuildStreamVideoItem</c>) silently drops entries that then fail to match
/// — Streamyfin's MPV profile declares <c>"h264, hevc"</c>, so the stray space evicted hevc
/// from the transcoding target list and every HEVC release was fully re-encoded to H.264
/// instead of stream-copied. <c>"h264, hevc"</c> can only mean <c>["h264","hevc"]</c>;
/// trimming is semantics-preserving and idempotent for well-formed profiles.
/// </para>
/// <para>
/// This is deliberately not client-sniffing: all three rules apply to every client, are no-ops
/// whenever the request is already well-formed, and encode no assumptions about any player's
/// URL choices. Play-method steering lives in <see cref="MediaSourceMapper"/>
/// (direct play is never advertised), not here.
/// </para>
/// <para>
/// Version-sensitive contracts this file binds (verified against Jellyfin 10.11.11): the
/// PlaybackInfo POST route shape; <c>MediaInfoController.GetPostedPlaybackInfo</c> binding the
/// query parameters <c>liveStreamId</c> / <c>autoOpenLiveStream</c> with precedence over the
/// posted body dto (<c>liveStreamId ??= playbackInfoDto?.LiveStreamId</c>); and the body
/// parameter being named <c>playbackInfoDto</c> with public <c>LiveStreamId</c> /
/// <c>AutoOpenLiveStream</c> properties. Any error or ABI drift falls through to the untouched
/// native action (BRIEF §11).
/// </para>
/// </summary>
public sealed class StreamarrPlaybackInfoGuard(
    StreamarrMediaSourceProjection projection,
    IMediaSourceManager mediaSourceManager,
    ILogger<StreamarrPlaybackInfoGuard> logger) : IAsyncActionFilter
{
    internal const string LiveStreamArgument = "liveStreamId";
    internal const string AutoOpenArgument = "autoOpenLiveStream";
    internal const string BodyArgument = "playbackInfoDto";
    internal const string OpenBodyArgument = "openLiveStreamDto";
    internal const string OpenItemArgument = "itemId";
    internal const string BodyLiveStreamProperty = "LiveStreamId";
    internal const string BodyAutoOpenProperty = "AutoOpenLiveStream";
    internal const string BodyDeviceProfileProperty = "DeviceProfile";
    internal const string BodyItemIdProperty = "ItemId";

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        try
        {
            HardenRequest(context);
        }
        catch (Exception ex)
        {
            // Non-negotiable: a broken guard must never break playback for anyone.
            logger.LogWarning(
                "Streamarr playback-info guard failed ({FailureType}); leaving the request untouched",
                ex.GetType().Name);
        }

        await next().ConfigureAwait(false);
    }

    private void HardenRequest(ActionExecutingContext context)
    {
        var request = context.HttpContext.Request;
        if (!HttpMethods.IsPost(request.Method))
            return;

        if (TryGetPlaybackInfoItemId(request.Path, out var itemId) && projection.Owns(itemId))
        {
            DropStaleLiveStreamId(context, itemId);
            DefaultAutoOpen(context, itemId);
            NormalizeDeviceProfile(context, BodyArgument, itemId);
            return;
        }

        if (IsLiveStreamOpenPath(request.Path)
            && RequestedOpenItemId(context) is { } openItemId
            && projection.Owns(openItemId))
        {
            NormalizeDeviceProfile(context, OpenBodyArgument, openItemId);
        }
    }

    private void DropStaleLiveStreamId(ActionExecutingContext context, Guid itemId)
    {
        var requested = RequestedLiveStreamId(context);
        if (string.IsNullOrWhiteSpace(requested))
            return;

        // Still open on this host: honoring it is correct and reuses the session.
        if (mediaSourceManager.GetLiveStreamInfo(requested) is not null)
            return;

        // Drift guard: the action must still *declare* the query parameter — the
        // bound-argument dictionary alone cannot prove this, because MVC may omit optional
        // query parameters the client did not send.
        if (context.ActionDescriptor?.Parameters is not { } parameters
            || !DeclaresParameter(parameters, LiveStreamArgument))
        {
            logger.LogWarning(
                "PlaybackInfo no longer declares '{LiveStream}'; skipping the Streamarr playback-info guard (see docs/jellyfin-compatibility.md)",
                LiveStreamArgument);
            return;
        }

        // Empty (rather than null) deliberately wins the controller's
        // `liveStreamId ??= dto.LiveStreamId` merge, so the dead id in the body can never
        // resurface; discovery + the client's AutoOpenLiveStream then open a fresh stream.
        context.ActionArguments[LiveStreamArgument] = string.Empty;
        logger.LogDebug(
            "Dropped a closed live-stream id from a PlaybackInfo request for Streamarr item {ItemId}; source discovery will open a fresh stream",
            itemId);
    }

    private void DefaultAutoOpen(ActionExecutingContext context, Guid itemId)
    {
        // Only when the request expresses no preference in either the query or the body:
        // an explicit true is already right, an explicit false signals a two-step opener.
        if (RequestedAutoOpen(context) is not null)
            return;

        if (context.ActionDescriptor?.Parameters is not { } parameters
            || !DeclaresParameter(parameters, AutoOpenArgument))
        {
            logger.LogWarning(
                "PlaybackInfo no longer declares '{AutoOpen}'; skipping the Streamarr auto-open default (see docs/jellyfin-compatibility.md)",
                AutoOpenArgument);
            return;
        }

        context.ActionArguments[AutoOpenArgument] = (bool?)true;
        logger.LogDebug(
            "Defaulted AutoOpenLiveStream=true for a preference-less PlaybackInfo request on Streamarr item {ItemId}",
            itemId);
    }

    private void NormalizeDeviceProfile(ActionExecutingContext context, string bodyArgument, Guid itemId)
    {
        // Same-assembly type as the host's dto property; ABI drift makes this pattern-match
        // fail and the guard falls through untouched.
        if (BodyProperty(context, bodyArgument, BodyDeviceProfileProperty) is not DeviceProfile profile)
            return;

        var repaired = NormalizeDeviceProfileLists(profile);
        if (repaired > 0)
        {
            logger.LogDebug(
                "Normalized {Count} malformed codec/container list(s) in the posted device profile for Streamarr item {ItemId}",
                repaired,
                itemId);
        }
    }

    /// <summary>
    /// Trims whitespace inside every comma-separated list field of the profile, in place.
    /// Returns how many fields were repaired; well-formed fields are left untouched.
    /// </summary>
    internal static int NormalizeDeviceProfileLists(DeviceProfile profile)
    {
        var repaired = 0;

        foreach (var direct in profile.DirectPlayProfiles ?? [])
        {
            direct.Container = Repair(direct.Container, ref repaired) ?? string.Empty;
            direct.VideoCodec = Repair(direct.VideoCodec, ref repaired);
            direct.AudioCodec = Repair(direct.AudioCodec, ref repaired);
        }

        foreach (var transcode in profile.TranscodingProfiles ?? [])
        {
            transcode.Container = Repair(transcode.Container, ref repaired) ?? string.Empty;
            transcode.VideoCodec = Repair(transcode.VideoCodec, ref repaired) ?? string.Empty;
            transcode.AudioCodec = Repair(transcode.AudioCodec, ref repaired) ?? string.Empty;
        }

        foreach (var codec in profile.CodecProfiles ?? [])
        {
            codec.Codec = Repair(codec.Codec, ref repaired);
            codec.Container = Repair(codec.Container, ref repaired);
            codec.SubContainer = Repair(codec.SubContainer, ref repaired);
        }

        foreach (var container in profile.ContainerProfiles ?? [])
        {
            container.Container = Repair(container.Container, ref repaired);
            container.SubContainer = Repair(container.SubContainer, ref repaired);
        }

        return repaired;
    }

    private static string? Repair(string? value, ref int repaired)
    {
        if (string.IsNullOrEmpty(value))
            return value;

        var normalized = string.Join(
            ',',
            value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));
        if (string.Equals(normalized, value, StringComparison.Ordinal))
            return value;

        repaired++;
        return normalized;
    }

    /// <summary>The id the request references: query argument first (controller precedence), then the posted dto.</summary>
    private static string? RequestedLiveStreamId(ActionExecutingContext context)
    {
        if (context.ActionArguments.TryGetValue(LiveStreamArgument, out var bound)
            && bound is string queryId
            && !string.IsNullOrWhiteSpace(queryId))
        {
            return queryId;
        }

        return BodyProperty(context, BodyArgument, BodyLiveStreamProperty) as string;
    }

    /// <summary>The opening preference the request expresses, if any.</summary>
    private static bool? RequestedAutoOpen(ActionExecutingContext context)
    {
        if (context.ActionArguments.TryGetValue(AutoOpenArgument, out var bound) && bound is bool queryValue)
            return queryValue;

        return BodyProperty(context, BodyArgument, BodyAutoOpenProperty) as bool?;
    }

    /// <summary>The item an open-live-stream request targets: query argument first, then the posted dto.</summary>
    private static Guid? RequestedOpenItemId(ActionExecutingContext context)
    {
        if (context.ActionArguments.TryGetValue(OpenItemArgument, out var bound)
            && bound is Guid queryId
            && queryId != Guid.Empty)
        {
            return queryId;
        }

        return BodyProperty(context, OpenBodyArgument, BodyItemIdProperty) is Guid bodyId && bodyId != Guid.Empty
            ? bodyId
            : null;
    }

    /// <summary>
    /// The plugin does not compile against Jellyfin.Api, so posted body dtos are read
    /// reflectively; a missing parameter or renamed property simply reads as "not supplied".
    /// </summary>
    private static object? BodyProperty(ActionExecutingContext context, string argumentName, string propertyName)
        => context.ActionArguments.TryGetValue(argumentName, out var dto) && dto is not null
            ? dto.GetType().GetProperty(propertyName)?.GetValue(dto)
            : null;

    private static bool DeclaresParameter(IEnumerable<ParameterDescriptor> parameters, string name)
        => parameters.Any(parameter => string.Equals(parameter.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Matches exactly <c>/LiveStreams/Open</c> — profile normalization only.</summary>
    internal static bool IsLiveStreamOpenPath(PathString path)
    {
        var parts = (path.Value ?? string.Empty)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 2
               && string.Equals(parts[0], "LiveStreams", StringComparison.OrdinalIgnoreCase)
               && string.Equals(parts[1], "Open", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Matches exactly <c>/Items/{itemId}/PlaybackInfo</c> — all three rules apply.</summary>
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
}
