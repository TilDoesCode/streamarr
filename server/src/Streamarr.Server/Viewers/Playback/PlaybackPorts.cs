using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Server.Services.Repair;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Viewers.Playback;

public sealed record PlaybackResolveCall(string ReleaseId, string WorkId, string ViewerId, string ViewerName, bool AutoFallback);

/// <summary>The resolve pipeline (health check, automatic fallback, repair) as viewer playback uses it.</summary>
public interface IPlaybackResolver
{
    Task<ResolveResponse> ResolveAsync(PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct);

    /// <summary>The repair job of a release, when one exists.</summary>
    RepairStatusInfo? RepairStatus(string releaseId);
}

/// <summary>A started server HLS rendition (remux or transcode).</summary>
public sealed record HlsRendition(string Id, DeliveryMode Mode, TranscodePlan Plan, SourceMediaInfo Media);

/// <summary>Probe, ffmpeg availability and HLS sessions of a resolved stream capability.</summary>
public interface IPlaybackMedia
{
    Task<ServerHls> ServerAsync(CancellationToken ct);

    /// <summary>The full probe of the capability; null when ffprobe cannot read it.</summary>
    Task<SourceMediaInfo?> ProbeAsync(string streamToken, CancellationToken ct);

    bool StreamAlive(string streamToken);

    Task<HlsRendition> StartHlsAsync(
        string streamToken, ClientProfile client, TranscodeLimits limits, string clientLabel, double startSeconds, ModePreference mode, CancellationToken ct);

    Task CloseHlsAsync(string id, string reason);

    void TouchHls(string id);
}

/// <summary>Resolves with client <c>streamarr-viewer</c> and the viewer id as requester, so pre-downloads and capability reuse stay per viewer.</summary>
public sealed class ServerPlaybackResolver(ResolveService resolve, TranscodeSourceResolver sources, RepairCoordinator? repair = null) : IPlaybackResolver
{
    public Task<ResolveResponse> ResolveAsync(PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct)
    {
        string local;
        try
        {
            local = sources.LocalBaseUrl();
        }
        catch (TranscodeException)
        {
            local = "http://127.0.0.1:1";
        }
        return resolve.ResolveAsync(
            call.ReleaseId,
            call.WorkId,
            ViewerCatalogService.PlaybackClient,
            call.ViewerId,
            call.ViewerName,
            call.AutoFallback,
            (token, _) => $"/api/v1/stream/{token}",
            token => $"{local}/api/v1/stream/{token}",
            ct,
            observer);
    }

    public RepairStatusInfo? RepairStatus(string releaseId)
        => repair?.GetJobByRelease(releaseId) is { } snapshot
            ? snapshot.ToStatusInfo(retryAfterSeconds: snapshot.IsTerminal ? null : 5)
            : null;
}

public sealed class ServerPlaybackMedia(
    TranscodeSessionManager transcodes,
    TranscodeSourceResolver sources,
    SessionManager streams,
    TranscodingSettingsService settings,
    FfmpegCapabilityService capabilities) : IPlaybackMedia
{
    public async Task<ServerHls> ServerAsync(CancellationToken ct)
    {
        var current = await settings.GetAsync(ct);
        var caps = await capabilities.GetAsync(ct);
        var code = !current.Enabled ? "transcoding_disabled" : !caps.Usable ? "ffmpeg_unavailable" : null;
        return new ServerHls(code is null, code, current, caps);
    }

    public Task<SourceMediaInfo?> ProbeAsync(string streamToken, CancellationToken ct)
        => transcodes.ProbeSourceAsync(sources.FromStreamToken(streamToken, out _), ct);

    public bool StreamAlive(string streamToken) => streams.TryGetSession(streamToken, out _);

    public async Task<HlsRendition> StartHlsAsync(
        string streamToken, ClientProfile client, TranscodeLimits limits, string clientLabel, double startSeconds, ModePreference mode, CancellationToken ct)
    {
        var source = sources.FromStreamToken(streamToken, out var title);
        var session = await transcodes.CreateAsync(source, title, client, limits, clientLabel, startSeconds, ct, mode);
        return new HlsRendition(session.Id, session.Mode, session.Plan, session.Media);
    }

    public async Task CloseHlsAsync(string id, string reason)
    {
        if (transcodes.TryGet(id, out var session))
            await transcodes.CloseAsync(session, reason);
    }

    public void TouchHls(string id)
    {
        if (transcodes.TryGet(id, out var session))
            session.Touch();
    }
}
