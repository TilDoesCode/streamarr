using System.Text.RegularExpressions;

namespace Streamarr.DevWorld.Faults;

/// <summary>Maps request paths to the delivery/API surfaces faults target (spec § 5).</summary>
public static partial class FaultMatcher
{
    public static ClassifiedRequest Classify(string method, string path)
    {
        if (TranscodeRegex().Match(path) is { Success: true } t)
        {
            if (HttpMethods.IsDelete(method))
                return ClassifiedRequest.None;
            var token = t.Groups["token"].Value;
            var rest = t.Groups["rest"].Value;
            if (rest == "master.m3u8")
                return new(RequestKind.Master, token);
            if (rest == "main.m3u8")
                return new(RequestKind.Media, token);
            if (rest == "init.mp4")
                return new(RequestKind.Init, token);
            if (SegmentRegex().Match(rest) is { Success: true } s)
                return new(RequestKind.Video, token, Segment: int.Parse(s.Groups[1].Value));
            if (RenditionRegex().Match(rest) is { Success: true } r)
            {
                var audio = r.Groups["kind"].Value == "audio";
                var file = r.Groups["file"].Value;
                var id = r.Groups["id"].Value;
                if (file == "main.m3u8")
                    return new(audio ? RequestKind.AudioPlaylist : RequestKind.SubtitlePlaylist, token, id);
                if (audio && file == "init.mp4")
                    return new(RequestKind.AudioInit, token, id);
                if (SegmentFileRegex().Match(file) is { Success: true } f)
                    return new(audio ? RequestKind.AudioSegment : RequestKind.SubtitleSegment, token, id, int.Parse(f.Groups[1].Value));
            }
            return ClassifiedRequest.None;
        }

        if (StreamRegex().Match(path) is { Success: true } d)
            return new(RequestKind.Direct, d.Groups["token"].Value);

        if (PlaybackRegex().Match(path) is { Success: true } p)
        {
            var id = p.Groups["id"].Success ? p.Groups["id"].Value : null;
            var action = p.Groups["action"].Success ? p.Groups["action"].Value : null;
            return (id, action) switch
            {
                (null, _) when HttpMethods.IsPost(method) => new(RequestKind.ApiStart),
                ({ }, null) when HttpMethods.IsGet(method) => new(RequestKind.ApiPoll, PlaybackId: id),
                ({ }, "switch") => new(RequestKind.ApiSwitch, PlaybackId: id),
                ({ }, "stop") => new(RequestKind.ApiStop, PlaybackId: id),
                _ => new(RequestKind.ViewerOther),
            };
        }

        if (path.Equals("/api/v1/viewer/watch/progress", StringComparison.OrdinalIgnoreCase))
            return new(RequestKind.ApiProgress);
        if (path.Equals("/api/v1/viewer/auth/refresh", StringComparison.OrdinalIgnoreCase))
            return new(RequestKind.Refresh);
        if (path.StartsWith("/api/v1/viewer", StringComparison.OrdinalIgnoreCase))
            return new(RequestKind.ViewerOther);
        return ClassifiedRequest.None;
    }

    /// <summary>Whether a fault aimed at <paramref name="target"/> applies to this request kind.</summary>
    public static bool TargetMatches(string fault, string? target, ClassifiedRequest request)
    {
        var kind = request.Kind;
        if (fault == "captive_portal")
            return request.IsHls || request.IsApi || kind is RequestKind.Direct or RequestKind.Refresh or RequestKind.ViewerOther;
        if (fault == "refresh_fail")
            return kind == RequestKind.Refresh;
        if (fault == "playback_gone")
            return kind is RequestKind.ApiPoll or RequestKind.ApiSwitch or RequestKind.ApiStop;
        if (fault == "transcode_kill")
            return request.IsHls;
        if (target is null)
            return false;

        var playlistFault = fault is "playlist_endless" or "playlist_event_stale";
        var anyPart = fault is "seg_status" or "rendition_status" or "subtitle_status" or "seg_delay" or "seg_stall" or "content_type";
        return target switch
        {
            "master" => kind == RequestKind.Master,
            "media" => fault == "early_end" ? kind == RequestKind.Video : kind == RequestKind.Media,
            "init" => kind == RequestKind.Init,
            "video" => kind == RequestKind.Video,
            "audio" => playlistFault ? kind == RequestKind.AudioPlaylist
                : anyPart ? kind is RequestKind.AudioPlaylist or RequestKind.AudioInit or RequestKind.AudioSegment
                : kind is RequestKind.AudioSegment || (fault is "seg_corrupt" or "seg_reset" && kind == RequestKind.AudioInit),
            "subtitle" => anyPart ? kind is RequestKind.SubtitlePlaylist or RequestKind.SubtitleSegment : kind == RequestKind.SubtitleSegment,
            "direct" => kind == RequestKind.Direct,
            "api:start" => kind == RequestKind.ApiStart,
            "api:poll" => kind == RequestKind.ApiPoll,
            "api:switch" => kind == RequestKind.ApiSwitch,
            "api:stop" => kind == RequestKind.ApiStop,
            "api:progress" => kind == RequestKind.ApiProgress,
            _ => false,
        };
    }

    /// <summary>The path with the capability token after <c>/stream/</c> or <c>/transcode/</c> replaced.</summary>
    public static string Redact(string path) => TokenRegex().Replace(path, "$1***");

    [GeneratedRegex(@"^/api/v1/transcode/(?<token>[^/]+)/(?<rest>.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex TranscodeRegex();

    [GeneratedRegex(@"^(\d+)\.m4s$")]
    private static partial Regex SegmentRegex();

    [GeneratedRegex(@"^(\d+)\.(m4s|vtt)$")]
    private static partial Regex SegmentFileRegex();

    [GeneratedRegex(@"^(?<kind>audio|subtitles)/(?<id>[^/]+)/(?<file>[^/]+)$")]
    private static partial Regex RenditionRegex();

    [GeneratedRegex(@"^/api/v1/stream/(?<token>[^/]+)/?", RegexOptions.IgnoreCase)]
    private static partial Regex StreamRegex();

    [GeneratedRegex(@"^/api/v1/viewer/playback(?:/(?<id>[^/]+)(?:/(?<action>[^/]+))?)?/?$", RegexOptions.IgnoreCase)]
    private static partial Regex PlaybackRegex();

    [GeneratedRegex(@"(/(?:stream|transcode)/)[^/?]+", RegexOptions.IgnoreCase)]
    private static partial Regex TokenRegex();
}
