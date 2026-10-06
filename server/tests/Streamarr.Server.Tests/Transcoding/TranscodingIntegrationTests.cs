using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Streamarr.Server.Transcoding;
using Streamarr.Tools.HlsSim;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Transcoding;

[Collection("transcoding-server")]
public sealed class TranscodingIntegrationTests(TranscodingServerFixture fixture, ITestOutputHelper output) : IAsyncLifetime
{
    private static readonly object Defaults = new
    {
        enabled = true,
        acceleration = "none",
        encoderPreset = "veryfast",
        segmentLengthSeconds = 4,
        maxHeight = 2160,
        throttleEnabled = true,
        throttleBufferSeconds = 120,
        maxConcurrentTranscodes = 2,
        jobIdleTimeoutSeconds = 60,
        segmentRetentionSeconds = 900,
        threads = 0,
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
        foreach (var session in await AdminSessionsAsync())
            await _admin.DeleteAsync($"/api/v1/transcoding/sessions/{session.GetProperty("handle").GetString()}");
        await ConfigureAsync(Defaults);
        _admin.Dispose();
        _machine.Dispose();
    }

    [Fact]
    public async Task Capabilities_DetectAUsableSoftwarePipelineWithTheInstalledFfmpeg()
    {
        var caps = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/capabilities");

        Assert.True(caps.GetProperty("ffmpegFound").GetBoolean());
        Assert.True(caps.GetProperty("usable").GetBoolean(), caps.GetRawText());
        Assert.Contains("libx264", caps.GetProperty("videoEncoders").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("scale", caps.GetProperty("filters").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(4, caps.GetProperty("accelerators").GetArrayLength());
    }

    [Fact]
    public async Task UsenetStream_IsTranscodedIntoContinuousKeyframeAlignedHls()
    {
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 360 });
        var plan = created.GetProperty("plan");

        Assert.False(plan.GetProperty("directPlayPossible").GetBoolean());
        Assert.Contains(plan.GetProperty("directPlayBlockers").EnumerateArray(), b => b.GetString()!.Contains("ac3"));
        Assert.Equal("h264", plan.GetProperty("target").GetProperty("videoCodec").GetString());
        Assert.Equal(2, plan.GetProperty("target").GetProperty("audioChannels").GetInt32());
        Assert.Equal(45, created.GetProperty("segmentCount").GetInt32());

        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, StopAfterMediaSeconds = 60, Decode = true });

        Assert.True(report.Passed, string.Join('\n', report.Errors));
        Assert.Equal(15, report.Fetches.Count);
        Assert.All(report.Fetches, f => Assert.True(f.StartsWithKeyframe, $"segment {f.Index} does not start with a keyframe"));
        Assert.All(report.Fetches, f => Assert.NotNull(f.AudioStart));
        Assert.NotNull(report.TimeToFirstSegmentMs);
    }

    [Fact]
    public async Task ForwardSeek_RestartsFfmpegAtTheTarget_AndKeepsTheTimelineOnTheGrid()
    {
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 });
        var report = await SimulateAsync(created, new HlsSimOptions
        {
            PlaybackRate = 0,
            StopAfterMediaSeconds = 40,
            Seeks = [new SeekStep(8, 120)],
            Decode = true,
        });

        Assert.True(report.Passed, string.Join('\n', report.Errors));
        Assert.Contains(report.Fetches, f => f.Index == 30);
        var afterSeek = report.Fetches.Where(f => f.Index >= 30).ToList();
        Assert.All(afterSeek, f => Assert.InRange(f.VideoStart!.Value - f.ExpectedStart, -0.2, 0.25));
        var session = await AdminSessionAsync(created);
        Assert.True(session.GetProperty("restarts").GetInt32() >= 1);
    }

    [Fact]
    public async Task BackwardSeek_IntoTranscodedRange_IsServedWithoutRestartingFfmpeg()
    {
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 });
        using var raw = RawClient();
        var basePath = BasePath(created);

        Assert.Equal(HttpStatusCode.OK, (await raw.GetAsync($"{basePath}/init.mp4")).StatusCode);
        for (var i = 0; i <= 6; i++)
            Assert.Equal(HttpStatusCode.OK, (await raw.GetAsync($"{basePath}/{i}.m4s")).StatusCode);
        var restartsBefore = (await AdminSessionAsync(created)).GetProperty("restarts").GetInt32();

        var response = await raw.GetAsync($"{basePath}/2.m4s");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(restartsBefore, (await AdminSessionAsync(created)).GetProperty("restarts").GetInt32());
    }

    [Fact]
    public async Task BackwardSeek_BehindTheRetainedWindow_RestartsTheRunAtTheTarget()
    {
        await ConfigureAsync(new { throttleBufferSeconds = 30, segmentRetentionSeconds = 60 });
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 });
        using var raw = RawClient();
        var basePath = BasePath(created);
        await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        for (var i = 0; i <= 24; i++)
            Assert.Equal(HttpStatusCode.OK, (await raw.GetAsync($"{basePath}/{i}.m4s")).StatusCode);
        var directory = Directory.GetDirectories(fixture.WorkspaceRoot, "*", SearchOption.AllDirectories)
            .Single(d => File.Exists(Path.Combine(d, "24.m4s")));
        await PollAsync(async () => { await Task.Yield(); return JsonSerializer.SerializeToElement(File.Exists(Path.Combine(directory, "2.m4s"))); },
            gone => !gone.GetBoolean(), TimeSpan.FromSeconds(20));
        var job = (await AdminSessionAsync(created)).GetProperty("job");
        Assert.True(job.GetProperty("running").GetBoolean() || job.GetProperty("paused").GetBoolean(), job.ToString());
        Assert.True(job.GetProperty("front").GetInt32() > 2);
        var restartsBefore = (await AdminSessionAsync(created)).GetProperty("restarts").GetInt32();

        var clock = System.Diagnostics.Stopwatch.StartNew();
        var response = await raw.GetAsync($"{basePath}/2.m4s");
        clock.Stop();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(15), $"took {clock.Elapsed}");
        Assert.Equal(restartsBefore + 1, (await AdminSessionAsync(created)).GetProperty("restarts").GetInt32());
        Assert.Equal(2, (await AdminSessionAsync(created)).GetProperty("job").GetProperty("startSegment").GetInt32());
    }

    [Fact]
    public async Task InitSegment_FromAMidFileStart_CarriesNoOffset_AndStaysStableAcrossRestarts()
    {
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240, startPositionSeconds = 100 });
        using var raw = RawClient();
        var basePath = BasePath(created);

        var first = await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        var segment = await raw.GetByteArrayAsync($"{basePath}/25.m4s");
        Assert.Equal(HttpStatusCode.OK, (await raw.GetAsync($"{basePath}/2.m4s")).StatusCode);
        var second = await raw.GetByteArrayAsync($"{basePath}/init.mp4");

        Assert.Equal(first, second);
        Assert.All(EmptyEditDurations(first), duration => Assert.Equal(0, duration));
        var init = Fmp4.ParseInit(first);
        Assert.NotNull(init.Video);
        Assert.NotNull(init.Audio);
        var video = Fmp4.ParseSegment(segment, init).Timings(init).Single(t => t.Handler == "vide");
        Assert.InRange(video.StartSeconds, 99.8, 100.3);
        Assert.True(video.StartsWithKeyframe);
    }

    [Fact]
    public async Task Throttling_ParksARunThatRacesAhead_AndResumesWhenThePlayerCatchesUp()
    {
        await ConfigureAsync(new { throttleBufferSeconds = 30, encoderPreset = "medium", threads = 1 });
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 360 });
        using var raw = RawClient();
        var basePath = BasePath(created);
        await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        await raw.GetByteArrayAsync($"{basePath}/0.m4s");

        var paused = await WaitForJobAsync(created, job => job.GetProperty("paused").GetBoolean(), TimeSpan.FromSeconds(60));
        var frontWhilePaused = paused.GetProperty("front").GetInt32();
        Assert.InRange(frontWhilePaused, 8, 14);
        await Task.Delay(1_500);
        Assert.Equal(frontWhilePaused, (await AdminSessionAsync(created)).GetProperty("job").GetProperty("front").GetInt32());

        await raw.GetByteArrayAsync($"{basePath}/{frontWhilePaused - 1}.m4s");
        var resumed = await WaitForJobAsync(created, job => !job.GetProperty("paused").GetBoolean(), TimeSpan.FromSeconds(10));
        Assert.True(resumed.GetProperty("running").GetBoolean());
        await WaitForJobAsync(created, job => job.GetProperty("front").GetInt32() > frontWhilePaused, TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task AThrottledRun_NeverDelaysAnotherStart()
    {
        await ConfigureAsync(new { throttleBufferSeconds = 30, encoderPreset = "medium", threads = 1 });
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 360 });
        using var raw = RawClient();
        var basePath = BasePath(created);
        await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        await raw.GetByteArrayAsync($"{basePath}/0.m4s");
        var parked = await WaitForJobAsync(created, job => job.GetProperty("paused").GetBoolean(), TimeSpan.FromSeconds(60));
        Assert.False(parked.GetProperty("running").GetBoolean());
        Assert.Empty(StoppedChildren());

        // B16: with SIGSTOP this blocked until the stopped ffmpeg went away (macOS waitid reports stopped children).
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var spawn = Task.Run(() =>
        {
            using var echo = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("/bin/echo", "x") { RedirectStandardOutput = true })!;
            echo.WaitForExit();
        });
        Assert.Same(spawn, await Task.WhenAny(spawn, Task.Delay(TimeSpan.FromSeconds(2))));
        var second = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 });
        var started = clock.Elapsed;
        Assert.True(started < TimeSpan.FromSeconds(2), $"spawn + second session start took {started.TotalSeconds:0.00} s");
        await raw.GetByteArrayAsync($"{BasePath(second)}/0.m4s");
        Assert.True((await AdminSessionAsync(created)).GetProperty("job").GetProperty("paused").GetBoolean());
    }

    /// <summary>Child processes of this test host that are stopped (ps state T).</summary>
    private static List<string> StoppedChildren()
    {
        using var ps = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("/bin/ps", "-A -o ppid=,pid=,stat=,comm=") { RedirectStandardOutput = true })!;
        var lines = ps.StandardOutput.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        ps.WaitForExit();
        var self = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return lines.Select(l => l.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .Where(f => f.Length >= 4 && f[0] == self && f[2].StartsWith('T'))
            .Select(f => string.Join(' ', f)).ToList();
    }

    [Fact]
    public async Task IdleRun_IsStopped_AndTheNextSegmentRequestStartsANewOne()
    {
        await ConfigureAsync(new { jobIdleTimeoutSeconds = 10, throttleBufferSeconds = 30 });
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 360 });
        using var raw = RawClient();
        var basePath = BasePath(created);
        await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        await raw.GetByteArrayAsync($"{basePath}/0.m4s");

        var stopped = await WaitForJobAsync(created, job => !job.GetProperty("running").GetBoolean(), TimeSpan.FromSeconds(30));
        var front = stopped.GetProperty("front").GetInt32();
        Assert.InRange(front, 8, 14);
        Assert.True(stopped.GetProperty("stoppedByServer").GetBoolean());
        Assert.Equal(JsonValueKind.Null, (await AdminSessionAsync(created)).GetProperty("lastError").ValueKind);

        var restartsBefore = (await AdminSessionAsync(created)).GetProperty("restarts").GetInt32();
        var response = await raw.GetAsync($"{basePath}/{front + 1}.m4s");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await AdminSessionAsync(created)).GetProperty("restarts").GetInt32() > restartsBefore);
    }

    [Fact]
    public async Task ConcurrencyLimit_RejectsANewRunWhileAnotherPlayerIsActive()
    {
        await ConfigureAsync(new { maxConcurrentTranscodes = 1, encoderPreset = "slow", threads = 1, throttleEnabled = false });
        var first = await CreateStreamSessionAsync(_machine, new { maxHeight = 360 });
        using var raw = RawClient();
        await raw.GetByteArrayAsync($"{BasePath(first)}/0.m4s");

        var token = await fixture.ResolveStreamTokenAsync(_machine);
        var second = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = token, maxHeight = 360 });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, second.StatusCode);
        Assert.Contains("transcode_capacity", await second.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task ConcurrentPlayers_EachGetAValidRendition()
    {
        await ConfigureAsync(new { maxConcurrentTranscodes = 3 });
        var sessions = new List<JsonElement>();
        for (var i = 0; i < 3; i++)
            sessions.Add(await CreateStreamSessionAsync(_machine, new { maxHeight = 240, clientName = $"player-{i}" }));

        var reports = await Task.WhenAll(sessions.Select((s, i) => SimulateAsync(s, new HlsSimOptions
        {
            PlaybackRate = 0,
            StopAfterMediaSeconds = 32,
            StartPositionSeconds = i * 40,
        })));

        Assert.All(reports, r => Assert.True(r.Passed, string.Join('\n', r.Errors)));
    }

    [Fact]
    public async Task CapabilityUrls_AreTheOnlyCredential_AndRejectEverythingElse()
    {
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 });
        using var raw = RawClient();
        var basePath = BasePath(created);

        var master = await raw.GetAsync($"{basePath}/master.m3u8");
        Assert.Equal(HttpStatusCode.OK, master.StatusCode);
        Assert.Equal("application/vnd.apple.mpegurl", master.Content.Headers.ContentType!.MediaType);
        Assert.Contains("no-store", master.Headers.CacheControl!.ToString());

        foreach (var path in new[]
                 {
                     "/api/v1/transcode/not-a-real-session/master.m3u8",
                     "/api/v1/transcode/not-a-real-session/0.m4s",
                     $"{basePath}/9999.m4s",
                     $"{basePath}/-2.m4s",
                     $"{basePath}/..%2F..%2Fstreamarr.db",
                 })
        {
            var response = await raw.GetAsync(path);
            Assert.True(response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized,
                $"{path} → {(int)response.StatusCode}");
        }

        Assert.Equal(HttpStatusCode.Forbidden, (await _machine.GetAsync("/api/v1/transcoding/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await _machine.GetAsync("/api/v1/transcoding/config")).StatusCode);
        var sample = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { sampleId = "h264-720p-aac" });
        Assert.Equal(HttpStatusCode.Forbidden, sample.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await raw.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = "x" })).StatusCode);
        var listing = await _admin.GetStringAsync("/api/v1/transcoding/sessions");
        Assert.DoesNotContain(basePath.Split('/')[^1], listing);
    }

    [Fact]
    public async Task StoppingATranscode_LeavesTheDirectPlayStreamUntouched()
    {
        var token = await fixture.ResolveStreamTokenAsync(_machine);
        var created = await CreateStreamSessionAsync(_machine, new { maxHeight = 240 }, token);
        using var raw = RawClient();
        var basePath = BasePath(created);
        await raw.GetByteArrayAsync($"{basePath}/0.m4s");
        var directory = Path.Combine(fixture.WorkspaceRoot, "sessions", basePath.Split('/')[^1]);
        Assert.True(Directory.Exists(directory));

        Assert.Equal(HttpStatusCode.NoContent, (await raw.DeleteAsync(basePath)).StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{basePath}/master.m3u8")).StatusCode);
        Assert.False(Directory.Exists(directory));
        using var head = new HttpRequestMessage(HttpMethod.Head, $"/api/v1/stream/{token}");
        Assert.Equal(HttpStatusCode.OK, (await raw.SendAsync(head)).StatusCode);
        using var range = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/stream/{token}");
        range.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 1023);
        var partial = await raw.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, partial.StatusCode);
        Assert.Equal(1024, (await partial.Content.ReadAsByteArrayAsync()).Length);
    }

    [Fact]
    public async Task Plan_ExplainsTheDecisionWithoutStartingFfmpeg()
    {
        var token = await fixture.ResolveStreamTokenAsync(_machine);
        var response = await _machine.PostAsJsonAsync("/api/v1/transcoding/plan", new
        {
            streamToken = token,
            client = new { videoCodecs = new[] { "h264" }, audioCodecs = new[] { "aac", "ac3" }, containers = new[] { "mkv", "mp4" }, maxAudioChannels = 6 },
        });
        response.EnsureSuccessStatusCode();
        var plan = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(plan.GetProperty("directPlayPossible").GetBoolean(), plan.GetRawText());
        Assert.Empty(await AdminSessionsAsync());
    }

    [Fact]
    public async Task Config_RoundTripsAndRejectsInvalidValues()
    {
        var invalid = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new { crf = 99 });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        var badAccel = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new { acceleration = "quantum" });
        Assert.Equal(HttpStatusCode.BadRequest, badAccel.StatusCode);
        var badDevice = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new { vaapiDevice = "/etc/passwd" });
        Assert.Equal(HttpStatusCode.BadRequest, badDevice.StatusCode);

        var saved = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", new
        {
            crf = 21, maxHeight = 1080, hardwareDecodingAuto = false, hardwareDecodingCodecs = new[] { "h264", "HEVC" },
        });
        saved.EnsureSuccessStatusCode();
        var config = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/config");

        Assert.Equal(21, config.GetProperty("crf").GetInt32());
        Assert.Equal(1080, config.GetProperty("maxHeight").GetInt32());
        Assert.False(config.GetProperty("hardwareDecodingAuto").GetBoolean());
        Assert.Equal(["h264", "hevc"], config.GetProperty("hardwareDecodingCodecs").EnumerateArray().Select(e => e.GetString()));
        await ConfigureAsync(new { crf = 23, hardwareDecodingAuto = true });
    }

    [Fact]
    public async Task DisabledTranscoding_RefusesNewSessions()
    {
        await ConfigureAsync(new { enabled = false });
        var token = await fixture.ResolveStreamTokenAsync(_machine);

        var response = await _machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = token });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("transcoding_disabled", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Benchmark_OnTheBuiltInSample_ReportsSpeedAndAlignedSegments()
    {
        var start = await _admin.PostAsJsonAsync("/api/v1/transcoding/benchmarks", new { sampleId = "h264-720p-aac", maxHeight = 360 });
        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
        var id = (await start.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();

        var run = await PollAsync(async () => await _admin.GetFromJsonAsync<JsonElement>($"/api/v1/transcoding/benchmarks/{id}"),
            r => r.GetProperty("state").GetString() is "completed" or "failed", TimeSpan.FromMinutes(3));

        Assert.Equal("completed", run.GetProperty("state").GetString());
        var result = run.GetProperty("result");
        output.WriteLine(result.GetRawText());
        Assert.NotEqual("failed", result.GetProperty("verdict").GetString());
        Assert.True(result.GetProperty("speed").GetDouble() > 1);
        Assert.True(result.GetProperty("keyframesAligned").GetBoolean());
        Assert.Equal(result.GetProperty("expectedSegments").GetInt32(), result.GetProperty("segments").GetInt32());
        Assert.Equal(360, result.GetProperty("outputHeight").GetInt32());
        Assert.Equal(JsonValueKind.Number, result.GetProperty("seekTimeToFirstSegmentMs").ValueKind);
        var source = run.GetProperty("plan").GetProperty("source");
        Assert.Equal("mp4", source.GetProperty("container").GetString());
        Assert.Equal("aac", source.GetProperty("audio")[0].GetProperty("codec").GetString());
    }

    [Theory]
    [InlineData("mpeg2-576i", true, false)]
    [InlineData("hevc-1080p-10bit", false, false)]
    [InlineData("hevc-2160p-hdr10", false, true)]
    public async Task Samples_PlayThroughTheirSpecialPipelines(string sampleId, bool deinterlaced, bool hdr)
    {
        var response = await _admin.PostAsJsonAsync("/api/v1/transcoding/sessions", new { sampleId, maxHeight = 480 });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        var plan = created.GetProperty("plan");

        Assert.Equal(deinterlaced, plan.GetProperty("deinterlace").GetBoolean());
        Assert.Equal(hdr, plan.GetProperty("source").GetProperty("hdr").GetString() != "none");
        if (hdr)
            Assert.NotEqual("notneeded", plan.GetProperty("toneMap").GetString());

        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, Decode = true });
        Assert.True(report.Passed, string.Join('\n', report.Errors));
        Assert.All(report.Fetches, f => Assert.True(f.StartsWithKeyframe));
    }

    [Fact]
    public async Task HardwareAcceleration_WhenAvailable_DecodesAndEncodesOnTheDevice()
    {
        var caps = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/capabilities");
        var recommended = caps.GetProperty("recommended").GetString();
        if (recommended is null or "none")
        {
            output.WriteLine("No hardware accelerator is available on this machine; nothing to verify.");
            return;
        }

        await ConfigureAsync(new { acceleration = recommended });
        var response = await _admin.PostAsJsonAsync("/api/v1/transcoding/sessions", new { sampleId = "hevc-1080p-10bit", maxHeight = 720 });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        var plan = created.GetProperty("plan");
        output.WriteLine(plan.GetRawText());

        Assert.True(plan.GetProperty("hardwareEncode").GetBoolean(), plan.GetProperty("hardwareEncodeReason").GetString());
        Assert.True(plan.GetProperty("hardwareDecode").GetBoolean(), plan.GetProperty("hardwareDecodeReason").GetString());
        var report = await SimulateAsync(created, new HlsSimOptions { PlaybackRate = 0, Decode = true, Seeks = [new SeekStep(4, 20)] });
        Assert.True(report.Passed, string.Join('\n', report.Errors));
    }

    private async Task<JsonElement> CreateStreamSessionAsync(HttpClient client, object options, string? token = null)
    {
        token ??= await fixture.ResolveStreamTokenAsync(client);
        var body = JsonSerializer.SerializeToElement(options);
        var request = new Dictionary<string, object?> { ["streamToken"] = token };
        foreach (var property in body.EnumerateObject())
            request[property.Name] = property.Value;
        var response = await client.PostAsJsonAsync("/api/v1/transcoding/sessions", request);
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private async Task<HlsSimReport> SimulateAsync(JsonElement created, HlsSimOptions options)
    {
        using var raw = RawClient();
        var simulator = new HlsPlayerSimulator(raw, options, line => output.WriteLine(line));
        var report = await simulator.RunAsync(new Uri(new Uri(fixture.BaseUrl), created.GetProperty("playlistUrl").GetString()), CancellationToken.None);
        output.WriteLine($"fetched {report.Fetches.Count} segments, ttfs {report.TimeToFirstSegmentMs:0} ms, p95 {report.LatencyPercentile(95):0} ms");
        foreach (var warning in report.Warnings)
            output.WriteLine($"warning: {warning}");
        return report;
    }

    private HttpClient RawClient() => fixture.CreateClient(authenticated: false);

    private static string BasePath(JsonElement created)
    {
        var playlist = created.GetProperty("playlistUrl").GetString()!;
        return playlist[..playlist.LastIndexOf('/')];
    }

    private async Task ConfigureAsync(object settings)
    {
        var response = await _admin.PutAsJsonAsync("/api/v1/transcoding/config", settings);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private async Task<IReadOnlyList<JsonElement>> AdminSessionsAsync()
        => (await _admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray().ToList();

    private async Task<JsonElement> AdminSessionAsync(JsonElement created)
    {
        var handle = created.GetProperty("handle").GetString();
        return (await AdminSessionsAsync()).Single(s => s.GetProperty("handle").GetString() == handle);
    }

    private Task<JsonElement> WaitForJobAsync(JsonElement created, Func<JsonElement, bool> condition, TimeSpan timeout)
        => PollAsync(
            async () => (await AdminSessionAsync(created)).GetProperty("job"),
            job => job.ValueKind == JsonValueKind.Object && condition(job),
            timeout);

    private static async Task<JsonElement> PollAsync(Func<Task<JsonElement>> read, Func<JsonElement, bool> done, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        JsonElement last;
        do
        {
            last = await read();
            if (done(last))
                return last;
            await Task.Delay(200);
        }
        while (DateTime.UtcNow < deadline);
        throw new TimeoutException($"Condition not met within {timeout}: {last.GetRawText()}");
    }

    private static IReadOnlyList<long> EmptyEditDurations(byte[] data)
    {
        var durations = new List<long>();
        void Walk(int from, int to)
        {
            var offset = from;
            while (offset + 8 <= to)
            {
                var size = (int)BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset));
                var type = Encoding.ASCII.GetString(data, offset + 4, 4);
                if (size < 8 || offset + size > to)
                    return;
                if (type is "moov" or "trak" or "edts")
                    Walk(offset + 8, offset + size);
                if (type == "elst")
                {
                    var body = data.AsSpan(offset + 8, size - 8);
                    var wide = body[0] == 1;
                    var count = (int)BinaryPrimitives.ReadUInt32BigEndian(body[4..]);
                    for (var i = 0; i < count; i++)
                    {
                        var entry = body[(8 + i * (wide ? 20 : 12))..];
                        var duration = wide ? (long)BinaryPrimitives.ReadUInt64BigEndian(entry) : BinaryPrimitives.ReadUInt32BigEndian(entry);
                        var mediaTime = wide ? BinaryPrimitives.ReadInt64BigEndian(entry[8..]) : BinaryPrimitives.ReadInt32BigEndian(entry[4..]);
                        if (mediaTime == -1)
                            durations.Add(duration);
                    }
                }
                offset += size;
            }
        }
        Walk(0, data.Length);
        return durations;
    }
}
