using System.Text.Json;

namespace Streamarr.DevWorld.Faults;

public enum RequestKind
{
    None,
    Master,
    Media,
    Init,
    Video,
    AudioPlaylist,
    AudioInit,
    AudioSegment,
    SubtitlePlaylist,
    SubtitleSegment,
    Direct,
    ApiStart,
    ApiPoll,
    ApiSwitch,
    ApiStop,
    ApiProgress,
    Refresh,
    ViewerOther,
    // In-process hooks (H3/H4), no HTTP request.
    HlsStart,
    Probe,
    StreamAlive,
    Resolve,
}

public sealed record ClassifiedRequest(RequestKind Kind, string? Token = null, string? Rendition = null, int? Segment = null, string? PlaybackId = null)
{
    public static readonly ClassifiedRequest None = new(RequestKind.None);

    public bool IsHls => Kind is RequestKind.Master or RequestKind.Media or RequestKind.Init or RequestKind.Video
        or RequestKind.AudioPlaylist or RequestKind.AudioInit or RequestKind.AudioSegment
        or RequestKind.SubtitlePlaylist or RequestKind.SubtitleSegment;

    public bool IsApi => Kind is RequestKind.ApiStart or RequestKind.ApiPoll or RequestKind.ApiSwitch or RequestKind.ApiStop or RequestKind.ApiProgress;
}

/// <summary>Who a request belongs to, as far as the fault layer knows.</summary>
public sealed record RequestScope(string? PlaybackId, string? WorkId, string? Viewer, DateTimeOffset? ReadyAt = null);

public sealed record FaultScope(string Kind, string? Value)
{
    public override string ToString() => Kind == "global" ? "global" : $"{Kind}:{Value}";
}

public sealed record FaultAfter(int? Segment, int? Requests, double? SecondsAfterReady, long? Bytes);

public sealed record FaultHit(DateTimeOffset At, string Method, string Path, string Status);

/// <summary>One armed fault; mutable counters are guarded by the registry lock.</summary>
public sealed class Fault
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required FaultScope Scope { get; set; }
    public string? Target { get; init; }
    public string? Rendition { get; init; }
    public required IReadOnlyDictionary<string, JsonElement> Params { get; init; }
    public required string Mode { get; init; }
    public int? Remaining { get; set; }
    public FaultAfter? After { get; init; }
    public required DateTimeOffset ArmedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; set; }
    public int Hits { get; set; }
    public int Seen { get; set; }
    public DateTimeOffset? FirstHitAt { get; set; }
    public List<FaultHit> LastHits { get; } = [];

    /// <summary>Per-fault scratch (e.g. the early_end cut-off, undo data).</summary>
    public Dictionary<string, object> State { get; } = [];

    public bool Spent => Remaining is <= 0;

    public string? Str(string name) => Params.TryGetValue(name, out var v)
        ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? null : v.GetRawText()
        : null;

    public double? Num(string name) => Params.TryGetValue(name, out var v)
        ? v.ValueKind == JsonValueKind.Number ? v.GetDouble()
        : v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : null
        : null;

    public int? Int(string name) => Num(name) is { } d ? (int)d : null;

    public bool Bool(string name) => Params.TryGetValue(name, out var v)
        && (v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.String && v.GetString() == "true"));

    public object ToSummary() => new
    {
        id = Id,
        fault = Name,
        scope = Scope.ToString(),
        target = Target,
        rendition = Rendition,
        @params = Params,
        mode = Mode,
        after = After,
        hits = Hits,
        remaining = Remaining,
        armedAt = ArmedAt,
        expiresAt = ExpiresAt,
    };
}

/// <summary>Every fault the layer knows, with its default and allowed targets (spec § 4).</summary>
public static class FaultCatalog
{
    private static readonly string[] SegTargets = ["video", "audio", "subtitle", "init"];
    private static readonly string[] StatusTargets = ["master", "media", "init", "video", "audio", "subtitle"];
    private static readonly string[] ApiTargets = ["api:start", "api:poll", "api:switch", "api:stop", "api:progress"];

    /// <summary>name → allowed targets (first = default); empty = no target.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Targets = new Dictionary<string, string[]>
    {
        ["seg_delay"] = SegTargets,
        ["seg_stall"] = SegTargets,
        ["seg_status"] = ["video", .. StatusTargets.Where(t => t != "video")],
        ["seg_reset"] = SegTargets,
        ["seg_truncate"] = ["video", "audio"],
        ["seg_corrupt"] = ["video", "audio", "init"],
        ["rendition_status"] = ["audio"],
        ["split_abort"] = ["audio"],
        ["subtitle_status"] = ["subtitle"],
        ["subtitle_corrupt"] = ["subtitle"],
        ["content_type"] = ["master", "media", "video", "subtitle"],
        ["playlist_endless"] = ["media", "audio"],
        ["playlist_event_stale"] = ["media"],
        ["early_end"] = ["video", "media", "direct"],
        ["throttle"] = ["video", "audio", "direct"],
        ["direct_status"] = ["direct"],
        ["direct_reset"] = ["direct"],
        ["direct_truncate"] = ["direct"],
        ["usenet_hole"] = [],
        ["usenet_stall"] = [],
        ["transcode_kill"] = [],
        ["transcode_slow"] = [],
        ["transcode_never_start"] = [],
        ["start_hang"] = [],
        ["probe_fail"] = [],
        ["stream_dead"] = [],
        ["resolve_hang"] = [],
        ["resolve_dead"] = [],
        ["api_status"] = ApiTargets,
        ["api_delay"] = ApiTargets,
        ["api_drop"] = ApiTargets,
        ["playback_stuck"] = ["api:poll"],
        ["playback_failed"] = ["api:poll", "api:switch"],
        ["captive_portal"] = [],
        ["token_expire"] = [],
        ["refresh_fail"] = [],
        ["session_revoke"] = [],
        ["password_change"] = [],
        ["playback_gone"] = [],
    };

    /// <summary>Faults that act once when armed (no request matching).</summary>
    public static readonly ISet<string> Actions = new HashSet<string> { "token_expire", "session_revoke", "password_change", "usenet_hole", "usenet_stall" };

    /// <summary>Faults whose effect lasts after their budget is spent; they stay listed until TTL or clear, which undoes them.</summary>
    public static readonly ISet<string> Lingering = new HashSet<string> { "password_change", "usenet_hole", "usenet_stall", "transcode_slow" };

    /// <summary>Faults that describe a state rather than one bad answer: <c>always</c> unless a mode is given.</summary>
    public static readonly ISet<string> StateLike = new HashSet<string>
        { "playback_gone", "playback_stuck", "captive_portal", "playlist_endless", "playlist_event_stale", "early_end", "direct_truncate", "throttle" };

    /// <summary>Faults that need a specific scope kind.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> RequiredScopes = new Dictionary<string, string[]>
    {
        ["token_expire"] = ["viewer"],
        ["session_revoke"] = ["viewer"],
        ["password_change"] = ["viewer"],
        ["playback_gone"] = ["playbackId"],
        ["usenet_hole"] = ["playbackId", "workId"],
        ["usenet_stall"] = ["playbackId", "workId"],
        ["transcode_kill"] = ["playbackId"],
    };

    public static readonly ISet<string> RevokeReasons = new HashSet<string>
        { "signed_out", "revoked_by_viewer", "session_limit", "admin", "password_changed", "account_disabled", "token_reused", "other" };

    /// <summary>The stored reason the product maps back to each public reason (ViewerSessionService.PublicReason).</summary>
    public static string StoredReason(string reason) => reason switch
    {
        "signed_out" => "logout",
        "admin" => "revoked_by_admin",
        "token_reused" => "refresh_token_reuse",
        "other" => "devworld_fault",
        _ => reason,
    };
}
