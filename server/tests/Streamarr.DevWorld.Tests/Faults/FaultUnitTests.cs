using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.DevWorld.Faults;

namespace Streamarr.DevWorld.Tests.Faults;

public class FaultUnitTests
{
    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 5, 0, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private readonly ManualTime _time = new();
    private readonly FaultRegistry _registry;

    public FaultUnitTests() => _registry = new FaultRegistry(_time, new PlaybackMap(_time), NullLoggerFactory.Instance);

    private Fault Arm(string json)
    {
        var (fault, error) = _registry.Arm(JsonDocument.Parse(json).RootElement);
        Assert.True(fault is not null, error);
        return fault!;
    }

    private string? Refused(string json) => _registry.Arm(JsonDocument.Parse(json).RootElement).Error;

    private static readonly RequestScope PlaybackA = new("pa", "w1", "anna");
    private static readonly RequestScope PlaybackB = new("pb", "w1", "kind");

    [Theory]
    [InlineData("GET", "/api/v1/transcode/tok/master.m3u8", RequestKind.Master, null, null)]
    [InlineData("GET", "/api/v1/transcode/tok/main.m3u8", RequestKind.Media, null, null)]
    [InlineData("GET", "/api/v1/transcode/tok/init.mp4", RequestKind.Init, null, null)]
    [InlineData("GET", "/api/v1/transcode/tok/12.m4s", RequestKind.Video, null, 12)]
    [InlineData("GET", "/api/v1/transcode/tok/audio/2/main.m3u8", RequestKind.AudioPlaylist, "2", null)]
    [InlineData("GET", "/api/v1/transcode/tok/audio/2/init.mp4", RequestKind.AudioInit, "2", null)]
    [InlineData("GET", "/api/v1/transcode/tok/audio/2/7.m4s", RequestKind.AudioSegment, "2", 7)]
    [InlineData("GET", "/api/v1/transcode/tok/subtitles/3/main.m3u8", RequestKind.SubtitlePlaylist, "3", null)]
    [InlineData("GET", "/api/v1/transcode/tok/subtitles/3/0.vtt", RequestKind.SubtitleSegment, "3", 0)]
    [InlineData("DELETE", "/api/v1/transcode/tok", RequestKind.None, null, null)]
    [InlineData("GET", "/api/v1/stream/tok", RequestKind.Direct, null, null)]
    [InlineData("POST", "/api/v1/viewer/playback", RequestKind.ApiStart, null, null)]
    [InlineData("GET", "/api/v1/viewer/playback/p1", RequestKind.ApiPoll, null, null)]
    [InlineData("POST", "/api/v1/viewer/playback/p1/switch", RequestKind.ApiSwitch, null, null)]
    [InlineData("POST", "/api/v1/viewer/playback/p1/stop", RequestKind.ApiStop, null, null)]
    [InlineData("POST", "/api/v1/viewer/watch/progress", RequestKind.ApiProgress, null, null)]
    [InlineData("POST", "/api/v1/viewer/auth/refresh", RequestKind.Refresh, null, null)]
    [InlineData("GET", "/api/v1/viewer/me", RequestKind.ViewerOther, null, null)]
    [InlineData("GET", "/api/v1/works", RequestKind.None, null, null)]
    public void Classify_MapsEveryDeliveryAndApiPath(string method, string path, RequestKind kind, string? rendition, int? segment)
    {
        var request = FaultMatcher.Classify(method, path);
        Assert.Equal(kind, request.Kind);
        Assert.Equal(rendition, request.Rendition);
        Assert.Equal(segment, request.Segment);
    }

    [Fact]
    public void Targets_HitOnlyTheirSurface()
    {
        var video = FaultMatcher.Classify("GET", "/api/v1/transcode/t/3.m4s");
        var audioPlaylist = FaultMatcher.Classify("GET", "/api/v1/transcode/t/audio/1/main.m3u8");
        var audioSegment = FaultMatcher.Classify("GET", "/api/v1/transcode/t/audio/1/0.m4s");
        Assert.True(FaultMatcher.TargetMatches("seg_status", "video", video));
        Assert.False(FaultMatcher.TargetMatches("seg_status", "media", video));
        Assert.True(FaultMatcher.TargetMatches("rendition_status", "audio", audioPlaylist));
        Assert.False(FaultMatcher.TargetMatches("seg_truncate", "audio", audioPlaylist));
        Assert.True(FaultMatcher.TargetMatches("seg_truncate", "audio", audioSegment));
        Assert.True(FaultMatcher.TargetMatches("playlist_endless", "audio", audioPlaylist));
        Assert.True(FaultMatcher.TargetMatches("early_end", "media", video));
        Assert.True(FaultMatcher.TargetMatches("captive_portal", null, FaultMatcher.Classify("GET", "/api/v1/stream/x")));
    }

    [Fact]
    public void Redact_HidesCapabilityTokens()
    {
        Assert.Equal("/api/v1/stream/***", FaultMatcher.Redact("/api/v1/stream/abcdef"));
        Assert.Equal("/api/v1/transcode/***/audio/1/0.m4s", FaultMatcher.Redact("/api/v1/transcode/secret/audio/1/0.m4s"));
        Assert.Equal("/api/v1/viewer/playback/p1", FaultMatcher.Redact("/api/v1/viewer/playback/p1"));
    }

    [Fact]
    public void Modes_OnceCountAlways()
    {
        var video = FaultMatcher.Classify("GET", "/api/v1/transcode/t/1.m4s");
        Arm("""{"fault":"seg_status","scope":{"playbackId":"pa"},"params":{"status":500}}""");
        Assert.NotNull(_registry.Match(video, PlaybackA));
        Assert.Null(_registry.Match(video, PlaybackA));

        _registry.Clear(null);
        var counted = Arm("""{"fault":"seg_status","scope":{"playbackId":"pa"},"mode":{"count":3}}""");
        Assert.Equal(3, Enumerable.Range(0, 5).Count(_ => _registry.Match(video, PlaybackA) is not null));
        Assert.Equal(0, counted.Remaining);
        Assert.Equal(3, counted.Hits);

        _registry.Clear(null);
        var always = Arm("""{"fault":"seg_status","scope":{"playbackId":"pa"},"mode":"always"}""");
        Assert.Equal(10, Enumerable.Range(0, 10).Count(_ => _registry.Match(video, PlaybackA) is not null));
        Assert.Null(always.Remaining);

        Assert.Equal("always", Arm("""{"fault":"playback_gone","scope":{"playbackId":"pa"}}""").Mode);
        Assert.Equal("once", Arm("""{"fault":"playback_gone","scope":{"playbackId":"pb"},"mode":"once"}""").Mode);
    }

    [Fact]
    public void Scope_PlaybackFaultNeverTouchesAnotherPlayback()
    {
        var video = FaultMatcher.Classify("GET", "/api/v1/transcode/t/1.m4s");
        Arm("""{"fault":"seg_status","scope":{"playbackId":"pa"},"mode":"always"}""");
        Assert.Null(_registry.Match(video, PlaybackB));
        Assert.NotNull(_registry.Match(video, PlaybackA));
    }

    [Fact]
    public void Scope_NextBecomesThePlaybackOfTheFirstStart()
    {
        var start = FaultMatcher.Classify("POST", "/api/v1/viewer/playback");
        var video = FaultMatcher.Classify("GET", "/api/v1/transcode/t/1.m4s");
        var fault = Arm("""{"fault":"seg_status","scope":{"next":"anna"},"mode":"always"}""");
        Assert.Null(_registry.Match(video, PlaybackA));
        _registry.BindNext("anna", "pa");
        Assert.Equal("playbackId:pa", fault.Scope.ToString());
        Assert.NotNull(_registry.Match(video, PlaybackA));
        Assert.Null(_registry.Match(video, PlaybackB));

        Arm("""{"fault":"api_status","scope":{"next":"kind"},"target":"api:start","params":{"status":409}}""");
        Assert.Null(_registry.Match(start, new RequestScope(null, null, "anna")));
        Assert.NotNull(_registry.Match(start, new RequestScope(null, null, "kind")));
    }

    [Fact]
    public void Ttl_ExpiresAndUndoes()
    {
        var removed = new List<string>();
        _registry.Removed += f => removed.Add(f.Id);
        var fault = Arm("""{"fault":"seg_delay","scope":{"global":true},"params":{"ms":10},"ttlSeconds":60}""");
        _time.Now = _time.Now.AddSeconds(61);
        Assert.Empty(_registry.List());
        Assert.Equal([fault.Id], removed);
    }

    [Fact]
    public void Global_OneAtATime()
    {
        Arm("""{"fault":"seg_delay","scope":{"global":true},"params":{"ms":10}}""");
        Assert.Contains("global", Refused("""{"fault":"direct_status","scope":{"global":true}}"""));
        _registry.Clear("global");
        Arm("""{"fault":"direct_status","scope":{"global":true}}""");
    }

    [Theory]
    [InlineData("""{"fault":"nope","scope":{"global":true}}""", "unknown fault")]
    [InlineData("""{"fault":"seg_status","scope":{}}""", "exactly one")]
    [InlineData("""{"fault":"seg_status","scope":{"global":true},"target":"direct"}""", "supports targets")]
    [InlineData("""{"fault":"token_expire","scope":{"global":true}}""", "needs scope viewer")]
    [InlineData("""{"fault":"seg_delay","scope":{"global":true}}""", "params.ms")]
    [InlineData("""{"fault":"seg_status","scope":{"global":true},"mode":"twice"}""", "mode")]
    [InlineData("""{"fault":"seg_status","scope":{"global":true},"ttlSeconds":7201}""", "ttlSeconds")]
    [InlineData("""{"fault":"session_revoke","scope":{"viewer":"anna"},"params":{"reason":"bored"}}""", "params.reason")]
    public void Arm_RefusesInvalidRequests(string json, string reason) => Assert.Contains(reason, Refused(json));

    [Fact]
    public void Every_SpecFault_IsKnown()
    {
        string[] spec =
        [
            "seg_delay", "seg_stall", "seg_status", "seg_reset", "seg_truncate", "seg_corrupt", "rendition_status", "split_abort",
            "subtitle_status", "subtitle_corrupt", "content_type", "playlist_endless", "playlist_event_stale", "early_end", "throttle",
            "direct_status", "direct_reset", "direct_truncate", "usenet_hole", "usenet_stall", "transcode_kill", "transcode_slow",
            "transcode_never_start", "start_hang", "probe_fail", "resolve_hang", "resolve_dead", "api_status", "api_delay", "api_drop",
            "playback_stuck", "playback_failed", "captive_portal", "token_expire", "refresh_fail", "session_revoke", "password_change",
            "playback_gone",
        ];
        Assert.Equal(38, spec.Length);
        Assert.All(spec, name => Assert.True(FaultCatalog.Targets.ContainsKey(name), name));
    }

    [Fact]
    public void After_SegmentAndRequests()
    {
        Arm("""{"fault":"seg_status","scope":{"playbackId":"pa"},"after":{"segment":20}}""");
        Assert.Null(_registry.Match(FaultMatcher.Classify("GET", "/api/v1/transcode/t/19.m4s"), PlaybackA));
        Assert.NotNull(_registry.Match(FaultMatcher.Classify("GET", "/api/v1/transcode/t/20.m4s"), PlaybackA));

        Arm("""{"fault":"api_drop","scope":{"playbackId":"pa"},"target":"api:poll","after":{"requests":2}}""");
        var poll = FaultMatcher.Classify("GET", "/api/v1/viewer/playback/pa");
        Assert.Null(_registry.Match(poll, PlaybackA));
        Assert.Null(_registry.Match(poll, PlaybackA));
        Assert.NotNull(_registry.Match(poll, PlaybackA));
    }

    [Fact]
    public void Playlist_DropsEndlistAndKeepsTheFirstSegments()
    {
        const string vod = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n"
                           + "#EXTINF:6.000,\n0.m4s\n#EXTINF:6.000,\n1.m4s\n#EXTINF:6.000,\n2.m4s\n#EXT-X-ENDLIST\n";
        var endless = FaultBodies.Playlist(vod, 2, eventType: false);
        Assert.DoesNotContain("ENDLIST", endless);
        Assert.DoesNotContain("PLAYLIST-TYPE", endless);
        Assert.Contains("1.m4s", endless);
        Assert.DoesNotContain("2.m4s", endless);
        Assert.Contains("#EXT-X-PLAYLIST-TYPE:EVENT", FaultBodies.Playlist(vod, 1, eventType: true));
    }

    [Fact]
    public void Corrupt_KeepsLengthAndChangesBytes()
    {
        var body = new byte[64];
        Encoding.ASCII.GetBytes("mdat").CopyTo(body, 36);
        body[35] = 28;
        Encoding.ASCII.GetBytes("styp").CopyTo(body, 4);
        body[3] = 32;
        foreach (var mode in (string[])["mdat", "box", "garbage"])
        {
            var corrupt = FaultBodies.Corrupt(body, mode);
            Assert.Equal(body.Length, corrupt.Length);
            Assert.NotEqual(body, corrupt);
        }
        Assert.Equal(32, FaultBodies.FindBox(body, "mdat"));
        Assert.True(FaultBodies.Corrupt(body, "mdat").Take(40).SequenceEqual(body.Take(40)));
    }

    [Fact]
    public void Vtt_HeaderAndTimingModes()
    {
        const string vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n";
        Assert.False(FaultBodies.CorruptVtt(vtt, "header").StartsWith("WEBVTT"));
        Assert.DoesNotContain("00:00:01.000 --> 00:00:02.000", FaultBodies.CorruptVtt(vtt, "timing"));
    }
}
