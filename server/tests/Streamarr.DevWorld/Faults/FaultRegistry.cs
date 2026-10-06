using System.Text.Json;

namespace Streamarr.DevWorld.Faults;

/// <summary>Thread-safe list of armed faults: arming, matching (with once/count/always and TTL) and hit bookkeeping.</summary>
public sealed class FaultRegistry(TimeProvider time, PlaybackMap playbacks, ILoggerFactory loggers)
{
    public const string LoggerName = "Streamarr.DevWorld.Faults";
    private const int DefaultTtl = 900;
    private const int MaxTtl = 7200;

    private readonly object _lock = new();
    private readonly List<Fault> _faults = [];
    private readonly Queue<Fault> _spent = new();
    private readonly ILogger _log = loggers.CreateLogger(LoggerName);
    private int _next;

    public TimeProvider Time => time;
    public PlaybackMap Playbacks => playbacks;

    /// <summary>Called (outside the lock) when a fault leaves the list, so actions can undo themselves.</summary>
    public event Action<Fault>? Removed;

    public (Fault? Fault, string? Error) Arm(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
            return (null, "body must be a JSON object");
        var nameProp = Prop(body, "fault");
        if (nameProp is not { ValueKind: JsonValueKind.String } || nameProp.Value.GetString() is not { Length: > 0 } name)
        {
            return (null, nameProp is null
                ? "fault is required: the fault name as a string (see the Dev World README)"
                : $"fault must be a non-empty string naming a fault, got {nameProp.Value.ValueKind.ToString().ToLowerInvariant()} {Shorten(nameProp.Value.GetRawText())}");
        }
        if (!FaultCatalog.Targets.TryGetValue(name, out var targets))
            return (null, $"fault: unknown fault '{Shorten(name)}'");

        var scopeError = ParseScope(Prop(body, "scope"), out var scope);
        if (scopeError is not null)
            return (null, scopeError);
        if (FaultCatalog.RequiredScopes.TryGetValue(name, out var required) && !required.Contains(scope!.Kind))
            return (null, $"{name} needs scope {string.Join(" or ", required)}");

        if (Prop(body, "target") is { ValueKind: not JsonValueKind.String })
            return (null, "target must be a string");
        var target = Prop(body, "target")?.GetString();
        if (targets.Length == 0 && target is not null)
            return (null, $"{name} takes no target");
        if (targets.Length > 0)
        {
            target ??= targets[0];
            if (!targets.Contains(target))
                return (null, $"{name} supports targets {string.Join(", ", targets)}");
        }

        var parameters = new Dictionary<string, JsonElement>();
        if (Prop(body, "params") is { ValueKind: JsonValueKind.Object } p)
            foreach (var item in p.EnumerateObject())
                parameters[item.Name] = item.Value.Clone();
        var rendition = Prop(body, "rendition") is { } rv ? (rv.ValueKind == JsonValueKind.String ? rv.GetString() : rv.GetRawText()) : null;
        if (rendition is null && parameters.TryGetValue("rendition", out var pr))
            rendition = pr.ValueKind == JsonValueKind.String ? pr.GetString() : pr.GetRawText();

        var modeError = ParseMode(Prop(body, "mode"), FaultCatalog.StateLike.Contains(name), out var mode, out var remaining);
        if (modeError is not null)
            return (null, modeError);
        var afterError = ParseAfter(Prop(body, "after"), out var after);
        if (afterError is not null)
            return (null, afterError);
        var paramError = Validate(name, parameters, scope!);
        if (paramError is not null)
            return (null, paramError);

        var ttlProp = Prop(body, "ttlSeconds");
        var ttl = DefaultTtl;
        if (ttlProp is { } t && (t.ValueKind != JsonValueKind.Number || !t.TryGetInt32(out ttl)))
            return (null, $"ttlSeconds must be a whole number 1..{MaxTtl}");
        if (ttl is < 1 or > MaxTtl)
            return (null, $"ttlSeconds must be 1..{MaxTtl}");

        var now = time.GetUtcNow();
        lock (_lock)
        {
            PruneLocked(now, out var expired);
            Notify(expired);
            if (scope!.Kind == "global" && _faults.Any(f => f.Scope.Kind == "global" && !f.Spent))
                return (null, "another global fault is armed; clear it first (one global fault at a time)");
            var fault = new Fault
            {
                Id = $"f{++_next}",
                Name = name,
                Scope = scope,
                Target = target,
                Rendition = rendition,
                Params = parameters,
                Mode = mode,
                Remaining = remaining,
                After = after,
                ArmedAt = now,
                ExpiresAt = now.AddSeconds(ttl),
            };
            _faults.Add(fault);
            _log.LogInformation("DevWorld fault {Id} {Fault} armed for {Scope} target {Target} mode {Mode}", fault.Id, name, scope, target, mode);
            return (fault, null);
        }
    }

    public IReadOnlyList<Fault> List()
    {
        List<Fault> expired;
        List<Fault> list;
        lock (_lock)
        {
            PruneLocked(time.GetUtcNow(), out expired);
            list = [.. _faults];
        }
        Notify(expired);
        return list;
    }

    /// <summary>A listed fault, or one of the last 50 that left the list because their budget was spent.</summary>
    public Fault? Get(string id)
    {
        if (List().FirstOrDefault(f => f.Id == id) is { } live)
            return live;
        lock (_lock)
            return _spent.FirstOrDefault(f => f.Id == id && f.ExpiresAt > time.GetUtcNow());
    }

    public bool Remove(string id)
    {
        Fault? fault;
        lock (_lock)
        {
            fault = _faults.FirstOrDefault(f => f.Id == id);
            if (fault is not null)
                _faults.Remove(fault);
            else if (_spent.FirstOrDefault(f => f.Id == id) is { } spent)
            {
                var kept = _spent.Where(f => f != spent).ToList();
                _spent.Clear();
                kept.ForEach(_spent.Enqueue);
                return true;
            }
        }
        if (fault is not null)
            Notify([fault]);
        return fault is not null;
    }

    /// <summary>Clears every fault, or those of one scope (<c>playbackId:…</c>, <c>viewer:…</c>, <c>global</c>).</summary>
    public int Clear(string? scope)
    {
        List<Fault> removed;
        lock (_lock)
        {
            removed = _faults.Where(f => scope is null || string.Equals(f.Scope.ToString(), scope, StringComparison.OrdinalIgnoreCase)).ToList();
            _faults.RemoveAll(removed.Contains);
        }
        Notify(removed);
        return removed.Count;
    }

    /// <summary>The first live fault for this request; consumes one hit of its budget.</summary>
    public Fault? Match(ClassifiedRequest request, RequestScope scope, long? rangeStart = null, Func<Fault, bool>? filter = null)
    {
        var now = time.GetUtcNow();
        List<Fault> expired;
        Fault? hit = null;
        lock (_lock)
        {
            PruneLocked(now, out expired);
            foreach (var fault in _faults)
            {
                if (fault.Spent || FaultCatalog.Actions.Contains(fault.Name) || !KindMatches(fault, request))
                    continue;
                if (fault.Rendition is not null && request.Rendition is not null && fault.Rendition != request.Rendition)
                    continue;
                if (!ScopeMatches(fault, request, scope) || (filter is not null && !filter(fault)))
                    continue;
                if (fault.After is { } after)
                {
                    if (after.Segment is { } segment && (request.Segment is not { } n || n < segment))
                        continue;
                    if (after.Bytes is { } bytes && (rangeStart ?? 0) < bytes)
                        continue;
                    if (after.SecondsAfterReady is { } seconds && (scope.ReadyAt is not { } ready || now < ready.AddSeconds(seconds)))
                        continue;
                    if (after.Requests is { } requests && ++fault.Seen <= requests)
                        continue;
                }
                if (fault.Name == "playback_stuck" && fault.FirstHitAt is { } first && now > first.AddSeconds(fault.Num("seconds") ?? 30))
                {
                    fault.Remaining = 0;
                    continue;
                }
                fault.Hits++;
                fault.FirstHitAt ??= now;
                if (fault.Remaining is not null)
                    fault.Remaining--;
                hit = fault;
                break;
            }
        }
        Notify(expired);
        return hit;
    }

    /// <summary>Marks an action fault as executed once.</summary>
    public void Consume(Fault fault)
    {
        lock (_lock)
        {
            fault.Hits++;
            fault.FirstHitAt ??= time.GetUtcNow();
            if (fault.Remaining is not null)
                fault.Remaining = Math.Max(0, fault.Remaining.Value - 1);
        }
    }

    public void RecordHit(Fault fault, string method, string path, string outcome)
    {
        var redacted = FaultMatcher.Redact(path);
        lock (_lock)
        {
            fault.LastHits.Add(new FaultHit(time.GetUtcNow(), method, redacted, outcome));
            if (fault.LastHits.Count > 20)
                fault.LastHits.RemoveAt(0);
        }
        _log.LogInformation("DevWorld fault {Id} {Fault} hit {Method} {Path} → {Outcome}", fault.Id, fault.Name, method, redacted, outcome);
    }

    /// <summary>Turns the viewer's unbound <c>next</c> faults into faults of this playback (first start answer).</summary>
    public void BindNext(string viewer, string playbackId)
    {
        lock (_lock)
        {
            foreach (var fault in _faults.Where(f => f.Scope.Kind == "next" && string.Equals(f.Scope.Value, viewer, StringComparison.OrdinalIgnoreCase)))
            {
                fault.State["nextViewer"] = viewer;
                fault.Scope = new FaultScope("playbackId", playbackId);
                _log.LogInformation("DevWorld fault {Id} {Fault} bound to playback {Playback}", fault.Id, fault.Name, playbackId);
            }
        }
    }

    public IReadOnlyList<Fault> Live(string name)
    {
        lock (_lock)
            return _faults.Where(f => f.Name == name && !f.Spent && f.ExpiresAt > time.GetUtcNow()).ToList();
    }

    public bool ScopeMatches(Fault fault, ClassifiedRequest request, RequestScope scope)
    {
        var internalKind = request.Kind is RequestKind.HlsStart or RequestKind.Probe or RequestKind.StreamAlive or RequestKind.Resolve;
        var value = fault.Scope.Value;
        switch (fault.Scope.Kind)
        {
            case "global":
                return true;
            case "workId":
                return string.Equals(scope.WorkId, value, StringComparison.OrdinalIgnoreCase);
            case "viewer":
                return string.Equals(scope.Viewer, value, StringComparison.OrdinalIgnoreCase);
            case "next":
                return (internalKind || request.Kind == RequestKind.ApiStart) && string.Equals(scope.Viewer, value, StringComparison.OrdinalIgnoreCase);
            case "playbackId":
                if (scope.PlaybackId is not null)
                    return scope.PlaybackId == value;
                if (!internalKind || playbacks.ById(value) is not { } record)
                    return false;
                return record.WorkId == scope.WorkId && string.Equals(record.Viewer, scope.Viewer, StringComparison.OrdinalIgnoreCase);
            default:
                return false;
        }
    }

    private static bool KindMatches(Fault fault, ClassifiedRequest request) => request.Kind switch
    {
        RequestKind.HlsStart => fault.Name is "transcode_never_start" or "start_hang",
        RequestKind.Probe => fault.Name == "probe_fail",
        RequestKind.StreamAlive => fault.Name == "stream_dead",
        RequestKind.Resolve => fault.Name is "resolve_hang" or "resolve_dead",
        _ => FaultMatcher.TargetMatches(fault.Name, fault.Target, request),
    };

    private void PruneLocked(DateTimeOffset now, out List<Fault> expired)
    {
        expired = _faults.Where(f => f.ExpiresAt <= now).ToList();
        if (expired.Count > 0)
            _faults.RemoveAll(expired.Contains);
        foreach (var spent in _faults.Where(f => f.Spent && !FaultCatalog.Lingering.Contains(f.Name)).ToList())
        {
            _faults.Remove(spent);
            _spent.Enqueue(spent);
            if (_spent.Count > 50)
                _spent.Dequeue();
        }
    }

    private void Notify(IEnumerable<Fault> removed)
    {
        foreach (var fault in removed)
        {
            try
            {
                Removed?.Invoke(fault);
            }
            catch (Exception e)
            {
                _log.LogWarning(e, "DevWorld fault {Id} undo failed", fault.Id);
            }
        }
    }

    private static string Shorten(string text) => text.Length <= 40 ? text : text[..40] + "…";

    private static JsonElement? Prop(JsonElement obj, string name)
        => obj.TryGetProperty(name, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? v : null;

    private static string? ParseScope(JsonElement? element, out FaultScope? scope)
    {
        scope = null;
        if (element is not { ValueKind: JsonValueKind.Object } obj)
            return "scope is required: { playbackId | workId | viewer | next | global: true }";
        var props = obj.EnumerateObject().ToList();
        if (props.Count != 1)
            return "scope needs exactly one of playbackId, workId, viewer, next, global";
        var prop = props[0];
        if (prop.Name == "global")
        {
            if (prop.Value.ValueKind != JsonValueKind.True)
                return "scope.global must be true";
            scope = new FaultScope("global", null);
            return null;
        }
        if (prop.Name is not ("playbackId" or "workId" or "viewer" or "next"))
            return $"unknown scope '{prop.Name}'";
        if (prop.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(prop.Value.GetString()))
            return $"scope.{prop.Name} must be a non-empty string";
        scope = new FaultScope(prop.Name, prop.Value.GetString()!);
        return null;
    }

    private static string? ParseMode(JsonElement? element, bool stateLike, out string mode, out int? remaining)
    {
        mode = stateLike ? "always" : "once";
        remaining = stateLike ? null : 1;
        if (element is null)
            return null;
        if (element.Value.ValueKind == JsonValueKind.String)
        {
            mode = element.Value.GetString()!;
            if (mode == "once")
                return null;
            if (mode == "always")
            {
                remaining = null;
                return null;
            }
            return "mode must be once, always or { count: N }";
        }
        if (element.Value.ValueKind == JsonValueKind.Object && element.Value.TryGetProperty("count", out var count)
            && count.TryGetInt32(out var n) && n >= 1)
        {
            mode = $"count:{n}";
            remaining = n;
            return null;
        }
        return "mode must be once, always or { count: N }";
    }

    private static string? ParseAfter(JsonElement? element, out FaultAfter? after)
    {
        after = null;
        if (element is null)
            return null;
        if (element.Value.ValueKind != JsonValueKind.Object)
            return "after must be an object";
        int? segment = null, requests = null;
        double? seconds = null;
        long? bytes = null;
        foreach (var prop in element.Value.EnumerateObject())
        {
            if (prop.Value.ValueKind != JsonValueKind.Number)
                return $"after.{prop.Name} must be a number";
            switch (prop.Name)
            {
                case "segment" when prop.Value.TryGetInt32(out var n): segment = n; break;
                case "requests" when prop.Value.TryGetInt32(out var n): requests = n; break;
                case "secondsAfterReady": seconds = prop.Value.GetDouble(); break;
                case "bytes" when prop.Value.TryGetInt64(out var n): bytes = n; break;
                case "segment" or "requests" or "bytes": return $"after.{prop.Name} must be a whole number";
                default: return $"unknown after.{prop.Name}";
            }
        }
        after = new FaultAfter(segment, requests, seconds, bytes);
        return null;
    }

    private static string? Validate(string name, Dictionary<string, JsonElement> p, FaultScope scope)
    {
        bool Has(string key) => p.ContainsKey(key);
        bool IsNum(string key) => p.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number;
        string? Str(string key) => p.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        foreach (var key in (string[])["mode", "signal", "state", "reason", "code", "value", "message"])
        {
            if (Has(key) && p[key].ValueKind != JsonValueKind.String)
                return $"params.{key} must be a string";
        }
        switch (name)
        {
            case "seg_delay" or "api_delay" when !IsNum("ms"):
                return $"{name} needs params.ms";
            case "seg_status" or "rendition_status" or "subtitle_status" or "direct_status" or "api_status" when Has("status") && !IsNum("status"):
                return "params.status must be a number";
            case "seg_reset" or "direct_reset" or "split_abort" when Has("afterBytes") && !IsNum("afterBytes"):
                return "params.afterBytes must be a number";
            case "seg_truncate" or "direct_truncate" when !IsNum("percent"):
                return $"{name} needs params.percent";
            case "seg_corrupt" when Has("mode") && Str("mode") is not ("mdat" or "box" or "garbage"):
                return "params.mode must be mdat, box or garbage";
            case "subtitle_corrupt" when Has("mode") && Str("mode") is not ("header" or "timing"):
                return "params.mode must be header or timing";
            case "content_type" when !Has("value"):
                return "content_type needs params.value";
            case "early_end" when !IsNum("atSeconds"):
                return "early_end needs params.atSeconds";
            case "throttle" when !IsNum("kbps"):
                return "throttle needs params.kbps";
            case "transcode_slow" when Has("readrate") && !IsNum("readrate"):
                return "params.readrate must be a number";
            case "transcode_kill" when Has("signal") && Str("signal") is not ("KILL" or "TERM"):
                return "params.signal must be KILL or TERM";
            case "playback_stuck" when Has("state") && Str("state") is not ("resolving" or "planning" or "starting"):
                return "params.state must be resolving, planning or starting";
            case "session_revoke" when Has("reason") && !FaultCatalog.RevokeReasons.Contains(Str("reason") ?? ""):
                return $"params.reason must be one of {string.Join(", ", FaultCatalog.RevokeReasons)}";
            case "usenet_hole" when !IsNum("fromPercent") || !IsNum("toPercent"):
                return "usenet_hole needs params.fromPercent and params.toPercent";
            case "usenet_hole" or "usenet_stall" when Has("file") && Str("file") is not ("media" or "recovery"):
                return "params.file must be media or recovery";
            case "usenet_hole" or "usenet_stall" when Has("releaseId") && Str("releaseId") is not { Length: > 0 }:
                return "params.releaseId must be a release id of the scoped title";
            case "captive_portal" when scope.Kind is not ("global" or "viewer"):
                return "captive_portal needs scope global or viewer";
            case "refresh_fail" when scope.Kind is not ("global" or "viewer"):
                return "refresh_fail needs scope global or viewer";
        }
        return null;
    }
}
