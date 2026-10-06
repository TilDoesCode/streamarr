using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.DevWorld.Faults;

/// <summary>H1 + H2: matches viewer media/API requests against armed faults, learns playbacks, applies the wire behaviour.</summary>
public sealed partial class DevWorldFaultMiddleware(
    RequestDelegate next, FaultRegistry registry, FaultIdentity identity, FaultActions actions, SessionManager streams, HlsDeliveryIssues issues)
{
    public const string Header = "X-DevWorld-Fault";
    private const string TranscoderAgent = "Streamarr-Transcoder/1";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private PlaybackMap Playbacks => registry.Playbacks;

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        var request = FaultMatcher.Classify(context.Request.Method, path);
        if (request.Kind == RequestKind.None || HttpMethods.IsOptions(context.Request.Method))
        {
            await next(context);
            return;
        }

        var scope = await ScopeAsync(context, request);
        var internalRead = request.Kind == RequestKind.Direct && IsTranscoderRead(context);
        var rangeStart = request.Kind == RequestKind.Direct ? ParseRange(context.Request.Headers.Range.ToString()).Start : null;
        var fault = registry.Match(request, scope, rangeStart, f =>
            (!internalRead || f.Bool("internal")) && (f.Name != "early_end" || EarlyEndApplies(f, request)));
        if (fault is null)
        {
            await PassAsync(context, request, scope);
            return;
        }

        context.Response.Headers[Header] = fault.Id;
        var outcome = await ApplyAsync(context, request, scope, fault);
        registry.RecordHit(fault, context.Request.Method, path, outcome);
    }

    private async Task<string> ApplyAsync(HttpContext context, ClassifiedRequest request, RequestScope scope, Fault fault)
    {
        var ct = context.RequestAborted;
        switch (fault.Name)
        {
            case "seg_delay" or "api_delay":
                await Task.Delay(TimeSpan.FromMilliseconds(fault.Num("ms") ?? 0), ct);
                await PassAsync(context, request, scope);
                return $"delayed {fault.Num("ms")} ms, {context.Response.StatusCode}";

            case "seg_stall":
            {
                var seconds = fault.Num("seconds");
                try
                {
                    await Task.Delay(seconds is { } s ? TimeSpan.FromSeconds(s) : Timeout.InfiniteTimeSpan, ct);
                }
                catch (OperationCanceledException)
                {
                    return "stalled until the client disconnected";
                }
                if (fault.Bool("respond"))
                    return await ErrorAsync(context, fault, 504, "segment_timeout");
                await PassAsync(context, request, scope);
                return $"stalled {seconds} s, {context.Response.StatusCode}";
            }

            case "seg_status" or "rendition_status" or "subtitle_status" or "api_status":
            {
                var status = fault.Int("status") ?? DefaultStatus(fault.Name);
                var code = fault.Str("code") ?? DefaultCode(fault.Name, status);
                return await ErrorAsync(context, fault, status, code, fault.Int("retryAfter"), fault.Str("body") == "html");
            }

            case "direct_status":
            {
                var status = fault.Int("status") ?? 500;
                if (status == 416)
                {
                    context.Response.StatusCode = 416;
                    context.Response.Headers.ContentRange = $"bytes */{FileSize(request.Token) ?? 0}";
                    return "416";
                }
                var retryAfter = fault.Int("retryAfter") ?? (status == 429 ? 1 : null);
                return await ErrorAsync(context, fault, status, fault.Str("code") ?? DefaultCode(fault.Name, status), retryAfter);
            }

            case "api_drop":
                context.Abort();
                return "connection aborted before any byte";

            case "playback_gone":
                return await ErrorAsync(context, fault, 404, "playback_not_found");

            case "captive_portal":
            {
                var html = "<!doctype html><html><head><title>Hotel Wi-Fi</title></head><body><h1>Welcome to Hotel Wi-Fi</h1>"
                    + "<p>Please accept the terms of use to continue.</p><form><button>Accept</button></form></body></html>";
                context.Response.StatusCode = 200;
                context.Response.ContentType = "text/html; charset=utf-8";
                await context.Response.WriteAsync(html, ct);
                return "200 captive portal page";
            }

            case "refresh_fail":
            {
                if (fault.Num("delayMs") is { } delay)
                    await Task.Delay(TimeSpan.FromMilliseconds(delay), ct);
                if (fault.Bool("drop"))
                {
                    context.Abort();
                    return "connection aborted";
                }
                if (fault.Int("status") is { } status && status != 401)
                    return await ErrorAsync(context, fault, status, fault.Str("code") ?? DefaultCode(fault.Name, status));
                if (fault.Str("code") is { } code)
                {
                    var reason = fault.Str("reason");
                    return await ErrorAsync(context, fault, 401, code, extra: reason is null ? null : new Dictionary<string, string> { ["reason"] = reason });
                }
                await PassAsync(context, request, scope);
                return $"delayed, {context.Response.StatusCode}";
            }

            case "early_end" when request.Kind == RequestKind.Direct:
            case "direct_truncate":
                return await LimitDirectAsync(context, request, scope, fault);

            case "early_end":
                return await ErrorAsync(context, fault, 404, "end_of_stream");

            case "direct_reset" or "throttle" when request.Kind == RequestKind.Direct:
                return await WrapDirectAsync(context, request, scope, fault);

            case "transcode_kill":
            {
                var killed = actions.Kill(fault, Playbacks.ById(scope.PlaybackId));
                await PassAsync(context, request, scope);
                return $"killed {killed} ffmpeg process(es), {context.Response.StatusCode}";
            }

            case "playback_stuck" or "playback_failed":
                return await RewriteApiAsync(context, request, scope, fault);

            default:
                return await TransformAsync(context, request, scope, fault);
        }
    }

    /// <summary>Faults that need the product's answer: rewrite the buffered body, then send it (or part of it).</summary>
    private async Task<string> TransformAsync(HttpContext context, ClassifiedRequest request, RequestScope scope, Fault fault)
    {
        var ct = context.RequestAborted;
        var (status, body) = await CaptureAsync(context);
        if (request.Kind == RequestKind.Media && status == 200)
            Playbacks.LearnSegments(request.Token!, Encoding.UTF8.GetString(body));
        if (status != 200 || context.Response.HasStarted)
        {
            await WriteAsync(context, body, ct);
            return $"product answered {status}, passed through";
        }

        switch (fault.Name)
        {
            case "seg_reset" or "split_abort":
            {
                // Like the product's own broken split: reported before the client sees the reset.
                if (fault.Name == "split_abort")
                    issues.Report(context.Request.Path, StatusCodes.Status500InternalServerError, fault.Str("code") ?? "rendition_split_failed");
                var after = (int)Math.Clamp(fault.Num("afterBytes") ?? body.Length / 2, 0, body.Length);
                context.Response.ContentLength = body.Length;
                await context.Response.Body.WriteAsync(body.AsMemory(0, after), ct);
                await context.Response.Body.FlushAsync(ct);
                await DrainThenAbortAsync(context);
                return $"reset after {after}/{body.Length} bytes";
            }
            case "seg_truncate":
            {
                var keep = (int)(body.Length * Math.Clamp(fault.Num("percent") ?? 50, 0, 100) / 100);
                context.Response.ContentLength = body.Length;
                await context.Response.Body.WriteAsync(body.AsMemory(0, keep), ct);
                await context.Response.Body.FlushAsync(ct);
                await DrainThenAbortAsync(context);
                return $"truncated to {keep}/{body.Length} bytes";
            }
            case "seg_corrupt":
            {
                var mode = fault.Str("mode") ?? "mdat";
                await WriteAsync(context, FaultBodies.Corrupt(body, mode), ct);
                return $"corrupted ({mode}) {body.Length} bytes";
            }
            case "subtitle_corrupt":
            {
                var mode = fault.Str("mode") ?? "header";
                await WriteAsync(context, Encoding.UTF8.GetBytes(FaultBodies.CorruptVtt(Encoding.UTF8.GetString(body), mode)), ct);
                return $"vtt corrupted ({mode})";
            }
            case "content_type":
            {
                context.Response.ContentType = fault.Str("value");
                await WriteAsync(context, body, ct);
                return $"Content-Type {fault.Str("value")}";
            }
            case "playlist_endless" or "playlist_event_stale":
            {
                var segments = fault.Int("segments") ?? 10;
                var text = FaultBodies.Playlist(Encoding.UTF8.GetString(body), segments, fault.Name == "playlist_event_stale");
                await WriteAsync(context, Encoding.UTF8.GetBytes(text), ct);
                return $"playlist cut to {segments} segments without ENDLIST";
            }
            case "throttle":
            {
                context.Response.ContentLength = body.Length;
                var pacer = new Pacer(fault.Num("kbps") ?? 256);
                for (var offset = 0; offset < body.Length; offset += pacer.Chunk)
                {
                    var n = Math.Min(pacer.Chunk, body.Length - offset);
                    await context.Response.Body.WriteAsync(body.AsMemory(offset, n), ct);
                    await context.Response.Body.FlushAsync(ct);
                    await pacer.WaitAsync(n, ct);
                }
                return $"throttled {body.Length} bytes at {fault.Num("kbps")} kbit/s";
            }
            default:
                await WriteAsync(context, body, ct);
                return "passed through";
        }
    }

    private async Task<string> RewriteApiAsync(HttpContext context, ClassifiedRequest request, RequestScope scope, Fault fault)
    {
        var (status, body) = await CaptureAsync(context);
        JsonNode? node = null;
        if (status is >= 200 and < 300 && body.Length > 0)
        {
            try
            {
                node = JsonNode.Parse(body);
            }
            catch (JsonException)
            {
            }
        }
        if (node is not JsonObject obj)
        {
            await WriteAsync(context, body, context.RequestAborted);
            return $"product answered {status}, passed through";
        }
        Learn(context, request, scope, obj);

        foreach (var name in (string[])["url", "streamToken", "method", "engine", "mediaInfo", "decision", "audioRenditions"])
            obj[name] = null;
        if (fault.Name == "playback_stuck")
        {
            obj["state"] = fault.Str("state") ?? "starting";
            obj["pollAfterMs"] = 500;
            obj["error"] = null;
        }
        else
        {
            obj["state"] = "failed";
            obj["pollAfterMs"] = 0;
            var code = fault.Str("code") ?? "transcode_failed";
            obj["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = fault.Str("message") ?? $"Dev World fault playback_failed ({code})",
                ["params"] = ParamsNode(fault),
            };
            obj["suggestedActions"] = fault.Params.TryGetValue("suggestedActions", out var actionsJson)
                ? JsonNode.Parse(actionsJson.GetRawText())
                : new JsonArray();
        }
        await WriteAsync(context, Encoding.UTF8.GetBytes(obj.ToJsonString(Json)), context.RequestAborted);
        return $"rewritten to {obj["state"]}";
    }

    /// <summary>direct_truncate / early_end on /stream: never deliver bytes past the limit; ranges beyond it get 416.</summary>
    private async Task<string> LimitDirectAsync(HttpContext context, ClassifiedRequest request, RequestScope scope, Fault fault)
    {
        if (!streams.TryGetSession(request.Token!, out var session))
        {
            await PassAsync(context, request, scope);
            return "unknown stream, passed through";
        }
        var size = session.File.SizeBytes;
        long limit;
        if (fault.Name == "direct_truncate")
            limit = (long)(size * Math.Clamp(fault.Num("percent") ?? 50, 0, 100) / 100);
        else
        {
            var duration = session.RunTimeTicks / (double)TimeSpan.TicksPerSecond;
            limit = duration > 0 ? (long)(size * Math.Clamp((fault.Num("atSeconds") ?? 0) / duration, 0, 1)) : size;
        }
        var (start, end) = ParseRange(context.Request.Headers.Range.ToString());
        var from = start ?? 0;
        if (from >= limit)
        {
            context.Response.StatusCode = 416;
            context.Response.Headers.ContentRange = $"bytes */{size}";
            return $"416 (range starts at {from}, limit {limit})";
        }
        var to = Math.Min(end ?? size - 1, limit - 1);
        context.Request.Headers.Range = $"bytes={from}-{to}";
        await PassAsync(context, request, scope);
        return $"range limited to {from}-{to} of {size}, {context.Response.StatusCode}";
    }

    private async Task<string> WrapDirectAsync(HttpContext context, ClassifiedRequest request, RequestScope scope, Fault fault)
    {
        var original = context.Response.Body;
        var wrapper = new FaultingStream(original, context,
            fault.Name == "direct_reset" ? (long)(fault.Num("afterBytes") ?? 65536) : null,
            fault.Name == "throttle" ? new Pacer(fault.Num("kbps") ?? 256) : null);
        context.Response.Body = wrapper;
        try
        {
            await next(context);
        }
        catch (Exception) when (wrapper.Aborted)
        {
        }
        finally
        {
            context.Response.Body = original;
        }
        return wrapper.Aborted ? $"reset after {wrapper.Written} bytes" : $"throttled {wrapper.Written} bytes";
    }

    private async Task PassAsync(HttpContext context, ClassifiedRequest request, RequestScope scope)
    {
        var learnApi = request.Kind is RequestKind.ApiStart or RequestKind.ApiPoll or RequestKind.ApiSwitch;
        if (!learnApi && request.Kind != RequestKind.Media)
        {
            await next(context);
            return;
        }
        var (status, body) = await CaptureAsync(context);
        if (status is >= 200 and < 300 && body.Length > 0)
        {
            if (request.Kind == RequestKind.Media)
                Playbacks.LearnSegments(request.Token!, Encoding.UTF8.GetString(body));
            else
            {
                try
                {
                    Learn(context, request, scope, JsonNode.Parse(body));
                }
                catch (JsonException)
                {
                }
            }
        }
        if (!context.Response.HasStarted)
            await WriteAsync(context, body, context.RequestAborted);
    }

    private void Learn(HttpContext context, ClassifiedRequest request, RequestScope scope, JsonNode? node)
    {
        var viewer = context.User.Identity?.IsAuthenticated == true ? context.User.Identity.Name : scope.Viewer;
        if (Playbacks.Learn(node, viewer) is { } record && request.Kind == RequestKind.ApiStart && viewer is not null)
            registry.BindNext(viewer, record.PlaybackId);
    }

    /// <summary>Kestrel drops unsent bytes on abort; give the flushed part a moment on the wire first.</summary>
    public static async Task DrainThenAbortAsync(HttpContext context)
    {
        await Task.Delay(150);
        context.Abort();
    }

    private async Task<(int Status, byte[] Body)> CaptureAsync(HttpContext context)
    {
        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next(context);
        }
        finally
        {
            context.Response.Body = original;
        }
        return (context.Response.StatusCode, buffer.ToArray());
    }

    private static async Task WriteAsync(HttpContext context, byte[] body, CancellationToken ct)
    {
        if (context.Response.HasStarted)
            return;
        context.Response.ContentLength = body.Length;
        if (body.Length > 0 && !HttpMethods.IsHead(context.Request.Method))
            await context.Response.Body.WriteAsync(body, ct);
    }

    /// <summary>A made-up error answer; it reaches the product's delivery-issue hook like the product's own errors.</summary>
    private async Task<string> ErrorAsync(
        HttpContext context, Fault fault, int status, string code, int? retryAfter = null, bool html = false, Dictionary<string, string>? extra = null)
    {
        issues.Report(context.Request.Path, status, code);
        context.Response.StatusCode = status;
        if (retryAfter is { } seconds)
            context.Response.Headers.RetryAfter = seconds.ToString();
        if (html)
        {
            context.Response.ContentType = "text/html; charset=utf-8";
            await context.Response.WriteAsync($"<html><body><h1>{status} {WebUtility.HtmlEncode(code)}</h1><p>Bad gateway</p></body></html>");
            return $"{status} html";
        }
        var parameters = ParamsNode(fault);
        foreach (var (key, value) in extra ?? [])
            parameters[key] = value;
        var envelope = new JsonObject
        {
            ["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = fault.Str("message") ?? $"Dev World fault {fault.Name} ({code})",
                ["params"] = parameters.Count > 0 ? parameters : null,
            },
        };
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsync(envelope.ToJsonString(Json));
        return $"{status} {code}";
    }

    private static JsonObject ParamsNode(Fault fault)
    {
        var result = new JsonObject();
        if (fault.Params.TryGetValue("params", out var p) && p.ValueKind == JsonValueKind.Object)
            foreach (var item in p.EnumerateObject())
                result[item.Name] = item.Value.ValueKind == JsonValueKind.String ? item.Value.GetString() : item.Value.GetRawText();
        return result;
    }

    private async Task<RequestScope> ScopeAsync(HttpContext context, ClassifiedRequest request)
    {
        if (request.IsHls || request.Kind == RequestKind.Direct)
        {
            if (Playbacks.ByToken(request.Token) is { } record)
                return new RequestScope(record.PlaybackId, record.WorkId, record.Viewer, record.ReadyAt);
            if (request.Token is not null && Playbacks.Resolved(request.Token) is { } resolved)
                return new RequestScope(null, resolved.WorkId, resolved.Viewer);
            return new RequestScope(null, null, null);
        }

        if (request.Kind == RequestKind.Refresh)
            return new RequestScope(null, null, await identity.ViewerByRefreshAsync(await RefreshTokenAsync(context), context.RequestAborted));

        var viewer = await identity.ViewerByAccessAsync(AccessToken(context), context.RequestAborted);
        var playback = Playbacks.ById(request.PlaybackId);
        return new RequestScope(request.PlaybackId, playback?.WorkId, viewer ?? playback?.Viewer, playback?.ReadyAt);
    }

    private static string? AccessToken(HttpContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return header[7..].Trim();
        return context.Request.Cookies[ViewerAuth.CookieName];
    }

    private static async Task<string?> RefreshTokenAsync(HttpContext context)
    {
        if (context.Request.ContentLength is > 0 and < 16384 || context.Request.Headers.TransferEncoding.Count > 0)
        {
            context.Request.EnableBuffering();
            try
            {
                using var doc = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("refreshToken", out var token) && token.ValueKind == JsonValueKind.String)
                    return token.GetString();
            }
            catch (JsonException)
            {
            }
            finally
            {
                context.Request.Body.Position = 0;
            }
        }
        return context.Request.Cookies[ViewerAuth.RefreshCookieName];
    }

    private bool EarlyEndApplies(Fault fault, ClassifiedRequest request)
    {
        if (request.Kind != RequestKind.Video || request.Segment is not { } n)
            return request.Kind == RequestKind.Direct;
        var start = Playbacks.SegmentStart(request.Token!, n) ?? n * 6.0;
        return start >= (fault.Num("atSeconds") ?? 0);
    }

    private long? FileSize(string? token) => token is not null && streams.TryGetSession(token, out var s) ? s.File.SizeBytes : null;

    private static bool IsTranscoderRead(HttpContext context)
        => context.Request.Headers.UserAgent.ToString().StartsWith(TranscoderAgent, StringComparison.Ordinal)
           && context.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip);

    public static (long? Start, long? End) ParseRange(string header)
    {
        if (RangeRegex().Match(header) is not { Success: true } m || m.Groups[1].Value.Length == 0)
            return (null, null);
        return (long.Parse(m.Groups[1].Value), m.Groups[2].Value.Length > 0 ? long.Parse(m.Groups[2].Value) : null);
    }

    private static int DefaultStatus(string fault) => fault switch
    {
        "rendition_status" or "subtitle_status" => 404,
        _ => 500,
    };

    public static string DefaultCode(string fault, int status) => (fault, status) switch
    {
        ("rendition_status", 404) => "unknown_audio_rendition",
        ("rendition_status", 500) => "rendition_split_failed",
        ("subtitle_status", 404) => "unknown_subtitle_stream",
        ("direct_status", 404) => "unknown_stream",
        ("direct_status", 429) => "stream_capacity",
        ("api_status", 404) => "playback_not_found",
        ("api_status", 409) => "too_many_streams",
        ("api_status", 429) => "too_many_playbacks",
        ("api_status", 503) => "catalog_unavailable",
        ("api_status", 403) => "age_restricted",
        (_, 404) => "unknown_segment",
        (_, 410) => "session_closed",
        (_, 500) when fault.StartsWith("seg_", StringComparison.Ordinal) => "transcode_failed",
        (_, 503) => "segment_unavailable",
        (_, 504) => "segment_timeout",
        _ => "internal_error",
    };

    [GeneratedRegex(@"^bytes=(\d*)-(\d*)$")]
    private static partial Regex RangeRegex();
}
