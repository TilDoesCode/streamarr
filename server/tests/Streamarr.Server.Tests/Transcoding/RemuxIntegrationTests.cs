using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Server.Transcoding;
using Streamarr.Tools.HlsSim;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>Real server + mock Usenet + real ffmpeg: stream copies validated with the hlssim player and ffprobe.</summary>
[Collection("remux-server")]
public sealed class RemuxIntegrationTests(RemuxServerFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static readonly object Defaults = new
    {
        enabled = true,
        acceleration = "none",
        segmentLengthSeconds = 4,
        throttleEnabled = true,
        throttleBufferSeconds = 120,
        maxConcurrentTranscodes = 2,
        maxConcurrentRemuxes = 8,
        jobIdleTimeoutSeconds = 60,
        encoderPreset = "veryfast",
        threads = 0,
    };

    private static readonly object HdrClient = new
    {
        videoCodecs = new[] { "h264", "hevc" },
        audioCodecs = new[] { "aac", "ac3", "eac3" },
        containers = new[] { "mp4" },
        maxAudioChannels = 6,
        supports10Bit = true,
        hdrFormats = new[] { "hdr10", "hlg" },
    };

    private HttpClient _admin = null!;
    private HttpClient _machine = null!;

    public async Task InitializeAsync()
    {
        _admin = await fixture.CreateAdminClientAsync();
        _machine = fixture.CreateClient();
        await ConfigureAsync(Defaults);
    }

    public async Task DisposeAsync()
    {
        foreach (var session in (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray())
            await _admin.DeleteAsync($"/api/v1/transcoding/sessions/{session.GetProperty("handle").GetString()}");
        await ConfigureAsync(Defaults);
        _admin.Dispose();
        _machine.Dispose();
    }

    [Fact]
    public async Task H264Eac3Mkv_ForABrowser_IsCopiedOnItsKeyframes_WithAacAudio_AndWebVttSubtitles()
    {
        var created = await CreateAsync(RemuxServerFixture.H264Mkv, new { mode = "auto" });
        var plan = created.GetProperty("plan");

        Assert.Equal("remux", created.GetProperty("mode").GetString());
        Assert.Equal("remux", plan.GetProperty("mode").GetString());
        Assert.Equal(["container_unsupported", "audio_codec_unsupported", "audio_converted"], Codes(plan.GetProperty("reasons")));
        var target = plan.GetProperty("target");
        Assert.True(target.GetProperty("videoCopy").GetBoolean());
        Assert.Matches("^avc1\\.64[0-9a-f]{4},mp4a\\.40\\.2$", target.GetProperty("codecs").GetString());
        Assert.Equal(("aac", 2), (target.GetProperty("audioCodec").GetString(), target.GetProperty("audioChannels").GetInt32()));
        Assert.Equal("matroska-cues", plan.GetProperty("keyframeIndex").GetProperty("source").GetString());
        Assert.Equal(["webvtt", "webvtt"], plan.GetProperty("subtitles").EnumerateArray().Select(s => s.GetProperty("deliveredAs").GetString()));
        Assert.Equal(15, created.GetProperty("segmentCount").GetInt32());

        using var raw = fixture.CreateClient(authenticated: false);
        var media = await raw.GetStringAsync($"{BasePath(created)}/main.m3u8");
        var durations = media.Split('\n').Where(l => l.StartsWith("#EXTINF:", StringComparison.Ordinal))
            .Select(l => double.Parse(l[8..].TrimEnd(','), CultureInfo.InvariantCulture)).ToList();
        var starts = durations.Select((_, i) => durations.Take(i).Sum()).ToList();
        Assert.Contains("#EXT-X-TARGETDURATION:8", media);
        Assert.Equal([0, 8, 13, 20, 27, 33, 40, 46, 52, 58, 64, 70, 76, 82, 88], starts.Select(s => Math.Round(s)));

        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, Decode = true, MaxStartDriftSeconds = 0.03, MaxLateDriftSeconds = 0.03 });

        Assert.True(report.Passed, string.Join('\n', report.Errors));
        Assert.Equal(15, report.Fetches.Count);
        Assert.All(report.Fetches.Skip(1), f => Assert.InRange(f.VideoStart!.Value - f.ExpectedStart, -0.002, 0.002));
        Assert.Equal(2, report.SubtitleRenditions);
        Assert.Equal(30, report.SubtitleSegments);
        Assert.Contains(report.SubtitleSamples, s => s.Contains("EN 1", StringComparison.Ordinal));

        var master = await raw.GetStringAsync(created.GetProperty("playlistUrl").GetString());
        Assert.Contains("TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\"", master);
        Assert.Contains("NAME=\"Deutsch\",LANGUAGE=\"de\"", master);
        Assert.Contains("VIDEO-RANGE=SDR,SUBTITLES=\"subs\",CLOSED-CAPTIONS=NONE", master);
        var english = plan.GetProperty("subtitles")[0].GetProperty("index").GetInt32();
        var spanning = await raw.GetStringAsync($"{BasePath(created)}/subtitles/{english}/1.vtt");
        var next = await raw.GetStringAsync($"{BasePath(created)}/subtitles/{english}/2.vtt");
        Assert.StartsWith("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n", spanning);
        Assert.Contains("EN spanning", spanning);
        Assert.Contains("EN spanning", next);
        Assert.Contains("EN 2", spanning);
        var german = await raw.GetStringAsync($"{BasePath(created)}/subtitles/{plan.GetProperty("subtitles")[1].GetProperty("index").GetInt32()}/5.vtt");
        Assert.Contains("<i>DE 4</i>", german);
        var tail = await raw.GetStringAsync($"{BasePath(created)}/subtitles/{english}/14.vtt");
        Assert.Contains("EN 9", await raw.GetStringAsync($"{BasePath(created)}/subtitles/{english}/13.vtt"));
        Assert.DoesNotContain("-->", tail);
    }

    [Fact]
    public async Task FarSeekBack_RestartsTheCopy_OnTheSameTimeline()
    {
        var created = await CreateAsync(RemuxServerFixture.H264Mkv, new { mode = "remux", startPositionSeconds = 70 });

        var report = await SimulateAsync(created, new HlsSimOptions
        {
            PlaybackRate = 0,
            StartPositionSeconds = 70,
            Seeks = [new SeekStep(80, 21)],
            Decode = true,
            MaxStartDriftSeconds = 0.03,
            MaxLateDriftSeconds = 0.03,
        });

        Assert.True(report.Passed, string.Join('\n', report.Errors));
        Assert.Contains(report.Fetches, f => f.Index == 3);
        Assert.All(report.Fetches.Where(f => f.Index > 0), f => Assert.InRange(f.VideoStart!.Value - f.ExpectedStart, -0.002, 0.002));
        var session = await AdminSessionAsync(created);
        Assert.Equal("remux", session.GetProperty("mode").GetString());
        Assert.True(session.GetProperty("restarts").GetInt32() >= 1);
        Assert.Contains("-ss", session.GetProperty("job").GetProperty("command").EnumerateArray().Select(a => a.GetString()));
    }

    [Fact]
    public async Task HevcMain10Hdr10_IsTaggedHvc1_SignalsPq_KeepsColour_AndDecodesAcrossSeeks()
    {
        var created = await CreateAsync(RemuxServerFixture.HevcHdr, new { mode = "remux", client = HdrClient });
        var target = created.GetProperty("plan").GetProperty("target");
        using var raw = fixture.CreateClient(authenticated: false);

        var master = await raw.GetStringAsync(created.GetProperty("playlistUrl").GetString());
        Assert.Matches("CODECS=\"hvc1\\.2\\.4\\.L\\d+\\.[0-9A-F]{2}[^\"]*,ac-3\"", master);
        Assert.Contains("RESOLUTION=640x360", master);
        Assert.Contains("VIDEO-RANGE=PQ", master);
        Assert.Equal("PQ", target.GetProperty("videoRange").GetString());
        Assert.True(target.GetProperty("audioCopy").GetBoolean());

        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, Seeks = [new SeekStep(8, 20)], Decode = true });
        Assert.True(report.Passed, string.Join('\n', report.Errors));

        var joined = Path.Combine(Path.GetTempPath(), $"remux-hdr-{Guid.NewGuid():N}.mp4");
        try
        {
            var init = await raw.GetByteArrayAsync($"{BasePath(created)}/init.mp4");
            Assert.True(FindBox(init, "hvc1") > 0, "sample entry is hvc1");
            var colr = FindBox(init, "colr");
            Assert.True(colr > 0);
            Assert.Equal("nclx", System.Text.Encoding.ASCII.GetString(init, colr + 8, 4));
            Assert.Equal((9, 16, 9), (init[colr + 13], init[colr + 15], init[colr + 17]));
            await using (var file = File.Create(joined))
            {
                await file.WriteAsync(init);
                for (var i = 0; i < 3; i++)
                    await file.WriteAsync(await raw.GetByteArrayAsync($"{BasePath(created)}/{i}.m4s"));
            }
            var probe = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,profile,codec_tag_string,pix_fmt,color_transfer,color_primaries,color_space", "-of", "default=nw=1", joined);
            output.WriteLine(probe);
            Assert.Contains("codec_name=hevc", probe);
            Assert.Contains("profile=Main 10", probe);
            Assert.Contains("codec_tag_string=hvc1", probe);
            Assert.Contains("color_transfer=smpte2084", probe);
            Assert.Contains("color_primaries=bt2020", probe);
            var frames = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
                "-show_frames", "-show_entries", "frame=side_data_list", "-of", "json", joined);
            Assert.Contains("Mastering display metadata", frames);
            Assert.Contains("Content light level metadata", frames);
        }
        finally
        {
            File.Delete(joined);
        }
    }

    [Theory]
    [InlineData(new[] { "aac", "ac3" }, 6, "ac3", 6, false)]
    [InlineData(new[] { "aac", "eac3" }, 6, "eac3", 6, true)]
    [InlineData(new[] { "aac", "eac3" }, 2, "aac", 2, false)]
    public async Task AudioLadder_DeliversWhatThePlayerDecodes(string[] audioCodecs, int maxChannels, string codec, int channels, bool copy)
    {
        var created = await CreateAsync(RemuxServerFixture.H264Mkv, new
        {
            mode = "remux",
            client = new { videoCodecs = new[] { "h264" }, audioCodecs, containers = new[] { "mp4" }, maxAudioChannels = maxChannels },
        });
        using var raw = fixture.CreateClient(authenticated: false);
        var joined = Path.Combine(Path.GetTempPath(), $"remux-audio-{Guid.NewGuid():N}.mp4");
        try
        {
            await using (var file = File.Create(joined))
            {
                await file.WriteAsync(await raw.GetByteArrayAsync($"{BasePath(created)}/init.mp4"));
                await file.WriteAsync(await raw.GetByteArrayAsync($"{BasePath(created)}/0.m4s"));
            }
            var probe = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,channels", "-of", "csv=p=0", joined);

            Assert.Equal($"{codec},{channels}", string.Join(',', probe.Trim().Split(',').Take(2)));
            Assert.Equal(copy, created.GetProperty("plan").GetProperty("target").GetProperty("audioCopy").GetBoolean());
        }
        finally
        {
            File.Delete(joined);
        }
    }

    [Theory]
    [InlineData(RemuxServerFixture.H264Mp4, "mp4-sample-table")]
    [InlineData(RemuxServerFixture.NoCuesMkv, "ffprobe-scan")]
    public async Task IndexSources_BeyondMatroskaCues_GiveTheSameKeyframePlan(string releaseId, string source)
    {
        var created = await CreateAsync(releaseId, new { mode = "remux" });
        var index = created.GetProperty("plan").GetProperty("keyframeIndex");

        Assert.Equal(source, index.GetProperty("source").GetString());
        Assert.Equal(15, created.GetProperty("segmentCount").GetInt32());
        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, StopAfterMediaSeconds = 40, Seeks = [new SeekStep(20, 60)], Decode = true });
        Assert.True(report.Passed, string.Join('\n', report.Errors));
    }

    [Fact]
    public async Task Plan_ExplainsDirectRemuxAndTranscode_AndAnImpossibleRemuxIs422()
    {
        var mp4Token = await fixture.ResolveStreamTokenAsync(_machine, RemuxServerFixture.H264Mp4, RemuxServerFixture.RemuxWorkId);
        var mkvToken = await fixture.ResolveStreamTokenAsync(_machine, RemuxServerFixture.H264Mkv, RemuxServerFixture.RemuxWorkId);
        var eac3Browser = new { videoCodecs = new[] { "h264" }, audioCodecs = new[] { "aac", "eac3" }, containers = new[] { "mp4" }, maxAudioChannels = 6 };
        var hevcOnly = new { videoCodecs = new[] { "hevc" }, audioCodecs = new[] { "aac" }, containers = new[] { "mp4" } };

        var direct = await PlanAsync(new { streamToken = mp4Token, client = eac3Browser });
        var remux = await PlanAsync(new { streamToken = mkvToken });
        var forced = await PlanAsync(new { streamToken = mkvToken, mode = "transcode" });
        var impossible = await PlanAsync(new { streamToken = mkvToken, mode = "remux", client = hevcOnly });
        var rejected = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = mkvToken, mode = "remux", client = hevcOnly });
        var invalid = await _machine.PostAsJsonAsync("/api/v1/transcoding/plan", new { streamToken = mkvToken, mode = "direct" });

        Assert.Equal(("direct", "direct_play"), (direct.GetProperty("mode").GetString(), Codes(direct.GetProperty("reasons")).Single()));
        Assert.Equal("remux", remux.GetProperty("mode").GetString());
        Assert.Equal("transcode", forced.GetProperty("mode").GetString());
        Assert.Equal("transcode_requested", Codes(forced.GetProperty("reasons")).First());
        Assert.True(forced.GetProperty("remuxPossible").GetBoolean());
        Assert.Equal("transcode", impossible.GetProperty("mode").GetString());
        Assert.Equal(["video_codec_unsupported"], Codes(impossible.GetProperty("remuxBlockers")));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, rejected.StatusCode);
        Assert.Contains("remux_not_possible", await rejected.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Empty((await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray());
    }

    [Fact]
    public async Task RemuxRuns_DoNotTakeTranscodeSlots_AndTheSettingIsValidated()
    {
        await ConfigureAsync(new { maxConcurrentTranscodes = 1, encoderPreset = "slow", threads = 1, throttleEnabled = false });
        var transcode = await CreateAsync(TranscodingServerFixture.ReleaseId, new { maxHeight = 360 }, TranscodingServerFixture.WorkId);
        using var raw = fixture.CreateClient(authenticated: false);
        await raw.GetByteArrayAsync($"{BasePath(transcode)}/0.m4s");

        var remux = await CreateAsync(RemuxServerFixture.H264Mkv, new { mode = "auto" });
        var token = await fixture.ResolveStreamTokenAsync(_machine);
        var secondTranscode = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = token, maxHeight = 360 });

        Assert.Equal("transcode", transcode.GetProperty("mode").GetString());
        Assert.Equal("remux", remux.GetProperty("mode").GetString());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, secondTranscode.StatusCode);
        Assert.Contains("transcode_capacity", await secondTranscode.Content.ReadAsStringAsync());
        var modes = (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray().Select(s => s.GetProperty("mode").GetString()).Order();
        Assert.Equal(["remux", "transcode"], modes);

        Assert.Equal(HttpStatusCode.BadRequest, (await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new { maxConcurrentRemuxes = 0 })).StatusCode);
        var config = await (await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new { maxConcurrentRemuxes = 12 })).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(12, config.GetProperty("maxConcurrentRemuxes").GetInt32());
    }

    [Fact]
    public async Task SubtitleRoutes_OnlyExistForDeliveredRenditions()
    {
        var remux = await CreateAsync(RemuxServerFixture.H264Mkv, new { mode = "remux" });
        var transcode = await CreateAsync(RemuxServerFixture.H264Mkv, new { maxHeight = 240 });
        using var raw = fixture.CreateClient(authenticated: false);
        var english = remux.GetProperty("plan").GetProperty("subtitles")[0].GetProperty("index").GetInt32();

        var playlist = await raw.GetAsync($"{BasePath(remux)}/subtitles/{english}/main.m3u8");
        Assert.Equal(HttpStatusCode.OK, playlist.StatusCode);
        Assert.Equal("application/vnd.apple.mpegurl", playlist.Content.Headers.ContentType!.MediaType);
        Assert.Equal("text/vtt", (await raw.GetAsync($"{BasePath(remux)}/subtitles/{english}/0.vtt")).Content.Headers.ContentType!.MediaType);
        Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{BasePath(remux)}/subtitles/0/main.m3u8")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{BasePath(remux)}/subtitles/{english}/99.vtt")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{BasePath(transcode)}/subtitles/{english}/0.vtt")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"/api/v1/transcode/not-a-session/subtitles/{english}/0.vtt")).StatusCode);
        Assert.DoesNotContain("SUBTITLES", await raw.GetStringAsync(transcode.GetProperty("playlistUrl").GetString()));
    }

    private async Task<JsonElement> CreateAsync(string releaseId, object options, string workId = RemuxServerFixture.RemuxWorkId)
    {
        var token = await fixture.ResolveStreamTokenAsync(_machine, releaseId, workId);
        var request = new Dictionary<string, object?> { ["streamToken"] = token };
        foreach (var property in JsonSerializer.SerializeToElement(options).EnumerateObject())
            request[property.Name] = property.Value;
        var response = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", request);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        output.WriteLine(created.GetProperty("plan").GetRawText());
        return created;
    }

    private async Task<JsonElement> PlanAsync(object request)
    {
        var response = await _machine.PostAsJsonAsync("/api/v1/transcoding/plan", request);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task<HlsSimReport> SimulateAsync(JsonElement created, HlsSimOptions options)
    {
        using var raw = fixture.CreateClient(authenticated: false);
        var simulator = new HlsPlayerSimulator(raw, options, line => output.WriteLine(line));
        var report = await simulator.RunAsync(new Uri(new Uri(fixture.BaseUrl), created.GetProperty("playlistUrl").GetString()), CancellationToken.None);
        foreach (var warning in report.Warnings)
            output.WriteLine($"warning: {warning}");
        return report;
    }

    private async Task<JsonElement> AdminSessionAsync(JsonElement created)
    {
        var handle = created.GetProperty("handle").GetString();
        return (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray()
            .Single(s => s.GetProperty("handle").GetString() == handle);
    }

    private async Task ConfigureAsync(object settings)
    {
        var response = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", settings);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private static List<string?> Codes(JsonElement reasons) => reasons.EnumerateArray().Select(r => r.GetProperty("code").GetString()).ToList();

    private static string BasePath(JsonElement created)
    {
        var playlist = created.GetProperty("playlistUrl").GetString()!;
        return playlist[..playlist.LastIndexOf('/')];
    }

    private static int FindBox(byte[] data, string type)
    {
        var pattern = System.Text.Encoding.ASCII.GetBytes(type);
        for (var i = 4; i + 4 <= data.Length; i++)
        {
            if (data.AsSpan(i, 4).SequenceEqual(pattern))
                return i - 4;
        }
        return -1;
    }
}
