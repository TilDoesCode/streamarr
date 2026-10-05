using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Server.Services.Repair;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.DevWorld.Faults;

/// <summary>H3: HLS start, probe and stream liveness faults around the product's playback media port.</summary>
public sealed class FaultPlaybackMedia(IPlaybackMedia inner, FaultRegistry registry) : IPlaybackMedia
{
    public Task<ServerHls> ServerAsync(CancellationToken ct) => inner.ServerAsync(ct);

    public async Task<SourceMediaInfo?> ProbeAsync(string streamToken, CancellationToken ct)
    {
        if (Match(RequestKind.Probe, streamToken) is { } fault)
        {
            registry.RecordHit(fault, "PROBE", "/api/v1/stream/" + streamToken, "probe returned nothing");
            return null;
        }
        return await inner.ProbeAsync(streamToken, ct);
    }

    public bool StreamAlive(string streamToken)
    {
        if (Match(RequestKind.StreamAlive, streamToken) is { } fault)
        {
            registry.RecordHit(fault, "ALIVE", "/api/v1/stream/" + streamToken, "stream reported dead");
            return false;
        }
        return inner.StreamAlive(streamToken);
    }

    public async Task<HlsRendition> StartHlsAsync(
        string streamToken, ClientProfile client, TranscodeLimits limits, string clientLabel, double startSeconds, ModePreference mode, CancellationToken ct)
    {
        if (Match(RequestKind.HlsStart, streamToken) is { } fault)
        {
            if (fault.Name == "start_hang")
            {
                var seconds = fault.Num("seconds") ?? 60;
                registry.RecordHit(fault, "START", "/api/v1/stream/" + streamToken, $"hls start held {seconds} s");
                await Task.Delay(TimeSpan.FromSeconds(seconds), ct);
            }
            else
            {
                var code = fault.Str("code") ?? "transcode_failed";
                var status = fault.Int("status") ?? (code is "transcode_capacity" or "remux_capacity" ? 503 : 500);
                registry.RecordHit(fault, "START", "/api/v1/stream/" + streamToken, $"threw {status} {code}");
                throw new TranscodeException(code, fault.Str("message") ?? $"Dev World fault transcode_never_start ({code})", status);
            }
        }
        return await inner.StartHlsAsync(streamToken, client, limits, clientLabel, startSeconds, mode, ct);
    }

    public Task CloseHlsAsync(string id, string reason) => inner.CloseHlsAsync(id, reason);

    public void TouchHls(string id) => inner.TouchHls(id);

    public DateTimeOffset? HlsLastAccess(string id) => inner.HlsLastAccess(id);

    private Fault? Match(RequestKind kind, string streamToken)
    {
        // Stream tokens are reused across playbacks of a viewer, so match by work and viewer, not by the token's last playback.
        var record = registry.Playbacks.ByToken(streamToken);
        var resolved = registry.Playbacks.Resolved(streamToken);
        var scope = new RequestScope(null, resolved?.WorkId ?? record?.WorkId, resolved?.Viewer ?? record?.Viewer);
        return registry.Match(new ClassifiedRequest(kind, streamToken), scope);
    }
}

/// <summary>H4: resolve hangs or reports the release dead; records which viewer/work a stream token belongs to.</summary>
public sealed class FaultPlaybackResolver(IPlaybackResolver inner, FaultRegistry registry, FaultActions actions) : IPlaybackResolver
{
    public async Task<ResolveResponse> ResolveAsync(PlaybackResolveCall call, IResolveObserver observer, CancellationToken ct)
    {
        var scope = new RequestScope(null, call.WorkId, call.ViewerName);
        if (registry.Match(new ClassifiedRequest(RequestKind.Resolve), scope) is { } fault)
        {
            if (fault.Name == "resolve_dead")
            {
                registry.RecordHit(fault, "RESOLVE", call.ReleaseId, "release reported dead");
                return new ResolveResponse { ReleaseId = call.ReleaseId, Status = "dead" };
            }
            var seconds = fault.Num("seconds") ?? 60;
            registry.RecordHit(fault, "RESOLVE", call.ReleaseId, $"resolve held {seconds} s");
            await Task.Delay(TimeSpan.FromSeconds(seconds), ct);
        }

        var response = await inner.ResolveAsync(call, observer, ct);
        if (response.StreamUrl is { } url && url.LastIndexOf("/stream/", StringComparison.Ordinal) is var i and >= 0)
        {
            var token = url[(i + 8)..].Split('?', '/')[0];
            registry.Playbacks.LearnResolve(token, call.WorkId, call.ViewerName);
            actions.OnResolved(token, call.WorkId, call.ViewerName);
        }
        return response;
    }

    public RepairStatusInfo? RepairStatus(string releaseId) => inner.RepairStatus(releaseId);
}
