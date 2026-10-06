using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>An ffmpeg whose session runs never write a segment (the probe and capability calls use the real one).</summary>
public sealed class StalledTranscodeFixture : TranscodingServerFixture
{
    public const int WaitSeconds = 5;
    public const string Origin = "https://watch.example";
    public const string SubtitledRelease = "rel-stalled-subtitled";

    protected override int SourceDurationSeconds => 60;
    protected override string SourceSize => "320x180";
    protected override int SegmentWaitTimeoutSeconds => WaitSeconds;

    protected override IReadOnlyDictionary<string, string?> ExtraSettings(string directory)
    {
        var script = Path.Combine(directory, "ffmpeg-stalled.sh");
        File.WriteAllText(script, "#!/bin/sh\ncase \" $* \" in *\" -progress \"*|*frag_discont*) exec sleep 120;; esac\nexec ffmpeg \"$@\"\n");
        File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return new Dictionary<string, string?>
        {
            ["Streamarr:Transcoding:FfmpegPath"] = script,
            ["Streamarr:ViewerCorsOrigins:0"] = Origin,
        };
    }

    protected override async Task<IReadOnlyList<FixtureRelease>> GenerateExtraReleasesAsync(string directory)
    {
        var srt = Path.Combine(directory, "stalled.srt");
        var mkv = Path.Combine(directory, "stalled-subtitled.mkv");
        await File.WriteAllTextAsync(srt, "1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:30,000 --> 00:00:32,000\nLater\n");
        await KeyframeFixture.FfmpegAsync(
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=60",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=60",
            "-i", srt, "-map", "0:v", "-map", "1:a", "-map", "2",
            "-c:v", "libx264", "-preset", "veryfast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-c:s", "srt",
            "-metadata:s:s:0", "language=eng", mkv);
        return [new(SubtitledRelease, WorkId, "Stalled.Subtitled.2024.1080p.WEB-DL.AAC.H.264.mkv", await File.ReadAllBytesAsync(mkv))];
    }
}

[CollectionDefinition("transcoding-stalled", DisableParallelization = true)]
public class StalledTranscodeCollection : ICollectionFixture<StalledTranscodeFixture>;

[Collection("transcoding-stalled")]
public sealed class TranscodeWaitTests(StalledTranscodeFixture fixture)
{
    [Fact]
    public void TheDefaultWaitBudget_EndsBeforeAPlayersFragmentTimeout()
        => Assert.Equal(25, new Streamarr.Server.Transcoding.TranscodingOptions().SegmentWaitTimeoutSeconds);

    [Theory]
    [InlineData("0.m4s")]
    [InlineData("init.mp4")]
    public async Task AStalledRun_Answers504WithRetryAfter_WhenTheWaitBudgetIsSpent(string file)
    {
        using var machine = fixture.CreateClient();
        var token = await fixture.ResolveStreamTokenAsync(machine);
        var created = await machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = token, maxHeight = 240 });
        Assert.True(created.StatusCode == HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var playlist = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("playlistUrl").GetString()!;
        using var raw = fixture.CreateClient(authenticated: false);
        try
        {
            var url = $"{playlist[..playlist.LastIndexOf('/')]}/{file}";
            using var preflight = new HttpRequestMessage(HttpMethod.Options, url);
            preflight.Headers.Add("Origin", StalledTranscodeFixture.Origin);
            preflight.Headers.Add("Access-Control-Request-Method", "GET");
            preflight.Headers.Add("Access-Control-Request-Headers", "range");
            var allowed = await raw.SendAsync(preflight);
            Assert.Equal(HttpStatusCode.NoContent, allowed.StatusCode);
            Assert.Equal(StalledTranscodeFixture.Origin, allowed.Headers.GetValues("Access-Control-Allow-Origin").Single());
            Assert.Contains("Range", allowed.Headers.GetValues("Access-Control-Allow-Headers").Single());

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("Origin", StalledTranscodeFixture.Origin);
            var clock = Stopwatch.StartNew();
            var response = await raw.SendAsync(request);
            clock.Stop();

            Assert.Equal(StalledTranscodeFixture.Origin, response.Headers.GetValues("Access-Control-Allow-Origin").Single());
            var exposed = response.Headers.GetValues("Access-Control-Expose-Headers").Single().Split(',', StringSplitOptions.TrimEntries);
            Assert.Contains("Retry-After", exposed);
            Assert.DoesNotContain(exposed, h => h.StartsWith("X-DevWorld", StringComparison.OrdinalIgnoreCase));

            Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
            Assert.Equal("segment_timeout", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(TimeSpan.FromSeconds(1), response.Headers.RetryAfter?.Delta);
            Assert.InRange(clock.Elapsed.TotalSeconds, StalledTranscodeFixture.WaitSeconds - 0.5, StalledTranscodeFixture.WaitSeconds + 3);
        }
        finally
        {
            await raw.DeleteAsync(playlist[..playlist.LastIndexOf('/')]);
        }
    }

    private async Task<(string Base, JsonElement Created)> CreateAsync(HttpClient machine, string? releaseId = null)
    {
        var token = releaseId is null
            ? await fixture.ResolveStreamTokenAsync(machine)
            : await fixture.ResolveStreamTokenAsync(machine, releaseId, TranscodingServerFixture.WorkId);
        var created = await machine.PostAsJsonAsync("/api/v1/transcoding/sessions", new { streamToken = token, maxHeight = 240 });
        Assert.True(created.StatusCode == HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        var playlist = body.GetProperty("playlistUrl").GetString()!;
        return (playlist[..playlist.LastIndexOf('/')], body);
    }

    private static async Task AssertSegmentTimeoutAsync(HttpResponseMessage response, TimeSpan elapsed)
    {
        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        Assert.Equal("segment_timeout", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(TimeSpan.FromSeconds(1), response.Headers.RetryAfter?.Delta);
        Assert.InRange(elapsed.TotalSeconds, StalledTranscodeFixture.WaitSeconds - 0.5, StalledTranscodeFixture.WaitSeconds + 2.5);
    }

    [Fact]
    public async Task ErrorAnswers_ReachTheDeliveryIssueHook_WithKindRenditionAndCode()
    {
        var issues = fixture.GetRequiredService<HlsDeliveryIssues>();
        var seen = new System.Collections.Concurrent.ConcurrentQueue<(string Session, HlsDeliveryIssue Issue)>();
        void Observe(string session, HlsDeliveryIssue issue) => seen.Enqueue((session, issue));
        issues.Observed += Observe;
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine, StalledTranscodeFixture.SubtitledRelease);
        var session = basePath[(basePath.LastIndexOf('/') + 1)..];
        using var raw = fixture.CreateClient(authenticated: false);
        try
        {
            var stream = created.GetProperty("plan").GetProperty("subtitles")[0].GetProperty("index").GetInt32();
            Assert.Equal(HttpStatusCode.GatewayTimeout, (await raw.GetAsync($"{basePath}/subtitles/{stream}/3.vtt")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{basePath}/audio/nope/main.m3u8")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await raw.GetAsync($"{basePath}/subtitles/99/main.m3u8")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await raw.GetAsync($"{basePath}/main.m3u8")).StatusCode);

            var mine = seen.Where(s => s.Session == session).Select(s => s.Issue).ToList();
            Assert.Collection(mine,
                i => Assert.Equal((HlsDeliveryKind.SubtitleRendition, (string?)null, (int?)stream, "segment_timeout", 504), (i.Kind, i.RenditionId, i.SubtitleStreamIndex, i.Code, i.Status)),
                i => Assert.Equal((HlsDeliveryKind.AudioRendition, (string?)"nope", (int?)null, "unknown_audio_rendition", 404), (i.Kind, i.RenditionId, i.SubtitleStreamIndex, i.Code, i.Status)),
                i => Assert.Equal((HlsDeliveryKind.SubtitleRendition, (string?)null, (int?)99, "unknown_subtitle_stream", 404), (i.Kind, i.RenditionId, i.SubtitleStreamIndex, i.Code, i.Status)));
        }
        finally
        {
            issues.Observed -= Observe;
            await raw.DeleteAsync(basePath);
        }
    }

    [Theory]
    [InlineData("/api/v1/transcode/abc/0.m4s", "abc", HlsDeliveryKind.Segment, null, null)]
    [InlineData("/api/v1/transcode/abc/init.mp4", "abc", HlsDeliveryKind.Segment, null, null)]
    [InlineData("/api/v1/transcode/abc/main.m3u8", "abc", HlsDeliveryKind.Segment, null, null)]
    [InlineData("/api/v1/transcode/abc/audio/2/7.m4s", "abc", HlsDeliveryKind.AudioRendition, "2", null)]
    [InlineData("/api/v1/transcode/abc/subtitles/4/3.vtt", "abc", HlsDeliveryKind.SubtitleRendition, null, 4)]
    public void DeliveryIssuePaths_AreClassifiedBySessionAndKind(string path, string session, HlsDeliveryKind kind, string? rendition, int? subtitle)
    {
        var target = HlsDeliveryIssues.Classify(path)!;
        Assert.Equal((session, kind, rendition, subtitle), (target.SessionId, target.Kind, target.RenditionId, target.SubtitleStreamIndex));
    }

    [Theory]
    [InlineData("/api/v1/stream/abc")]
    [InlineData("/api/v1/viewer/playback/abc")]
    [InlineData("/api/v1/transcode/abc")]
    [InlineData("/api/v1/transcode/abc/subtitles/x/3.vtt")]
    public void OtherPaths_AreNoDeliveryIssues(string path) => Assert.Null(HlsDeliveryIssues.Classify(path));

    [Fact]
    public async Task AWebVttSegmentOfAStalledRun_Answers504WithRetryAfter_WithinTheWaitBudget()
    {
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine, StalledTranscodeFixture.SubtitledRelease);
        using var raw = fixture.CreateClient(authenticated: false);
        try
        {
            var stream = created.GetProperty("plan").GetProperty("subtitles")[0].GetProperty("index").GetInt32();
            var clock = Stopwatch.StartNew();
            using var response = await raw.GetAsync($"{basePath}/subtitles/{stream}/3.vtt");
            await AssertSegmentTimeoutAsync(response, clock.Elapsed);
        }
        finally
        {
            await raw.DeleteAsync(basePath);
        }
    }

    [Fact]
    public async Task OneWaitBudget_CoversEveryFfmpegRestartOfARequest()
    {
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine);
        var far = created.GetProperty("segmentCount").GetInt32() - 1;
        using var raw = fixture.CreateClient(authenticated: false);
        try
        {
            var clock = Stopwatch.StartNew();
            var victim = raw.GetAsync($"{basePath}/0.m4s");
            // A far request at 3 s restarts the run there; the victim waits for it (B16) and still answers at its 5 s budget.
            await Task.Delay(3000);
            using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(250)))
            {
                try
                {
                    using var _ = await raw.GetAsync($"{basePath}/{far}.m4s", cancel.Token);
                }
                catch (OperationCanceledException)
                {
                }
            }
            using var response = await victim;
            var elapsed = clock.Elapsed;
            using var admin = await fixture.CreateAdminClientAsync();
            var sessions = await admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions");
            var session = sessions.EnumerateArray().Single(s => s.GetProperty("handle").GetString() == created.GetProperty("handle").GetString());
            Assert.True(session.GetProperty("restarts").GetInt32() >= 1, $"restarts {session.GetProperty("restarts")}");
            await AssertSegmentTimeoutAsync(response, elapsed);
        }
        finally
        {
            await raw.DeleteAsync(basePath);
        }
    }

    [Fact]
    public async Task TwoRequestsFarApart_DoNotPingPongRestarts_TheNewerPositionKeepsTheRun()
    {
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine);
        using var raw = fixture.CreateClient(authenticated: false);
        using var admin = await fixture.CreateAdminClientAsync();
        try
        {
            var far = created.GetProperty("segmentCount").GetInt32() - 2;
            var clock = Stopwatch.StartNew();
            var victim = raw.GetAsync($"{basePath}/0.m4s");
            await Task.Delay(1000);
            var competitor = raw.GetAsync($"{basePath}/{far}.m4s");
            using var first = await victim;
            var victimDone = clock.Elapsed;
            using var second = await competitor;

            // Before B16 each attempt restarted the run at its own segment (≈ 7 restarts in 4 s, then 503 segment_unavailable).
            var sessions = await admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions");
            var session = sessions.EnumerateArray().Single(s => s.GetProperty("handle").GetString() == created.GetProperty("handle").GetString());
            Assert.Equal(1, session.GetProperty("restarts").GetInt32());
            Assert.Equal(far, session.GetProperty("job").GetProperty("startSegment").GetInt32());
            await AssertSegmentTimeoutAsync(first, victimDone);
            Assert.Equal(HttpStatusCode.GatewayTimeout, second.StatusCode);
        }
        finally
        {
            await raw.DeleteAsync(basePath);
        }
    }

    [Fact]
    public async Task OnePlayersOwnSeekBack_RestartsAtOnce_AndItsAbandonedFarRequestNeverMovesTheRunAgain()
    {
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine);
        using var raw = fixture.CreateClient(authenticated: false);
        using var admin = await fixture.CreateAdminClientAsync();
        try
        {
            var far = created.GetProperty("segmentCount").GetInt32() - 2;
            var abandoned = raw.GetAsync($"{basePath}/{far}.m4s");
            await Task.Delay(1000);
            var back = raw.GetAsync($"{basePath}/1.m4s");
            await Task.Delay(500);
            var session = await SessionAsync(admin, created);
            Assert.Equal(2, session.GetProperty("restarts").GetInt32());
            Assert.Equal(1, session.GetProperty("job").GetProperty("startSegment").GetInt32());

            using var first = await abandoned;
            using var second = await back;
            Assert.Equal(HttpStatusCode.GatewayTimeout, first.StatusCode);
            Assert.Equal(HttpStatusCode.GatewayTimeout, second.StatusCode);
            session = await SessionAsync(admin, created);
            Assert.Equal(2, session.GetProperty("restarts").GetInt32());
            Assert.Equal(1, session.GetProperty("job").GetProperty("startSegment").GetInt32());
        }
        finally
        {
            await raw.DeleteAsync(basePath);
        }
    }

    [Fact]
    public async Task OnePlayerFlippingFarAndNear_RestartsAtMostAboutOncePerSecond_AndTheLatestPositionWins()
    {
        using var machine = fixture.CreateClient();
        var (basePath, created) = await CreateAsync(machine);
        using var raw = fixture.CreateClient(authenticated: false);
        using var admin = await fixture.CreateAdminClientAsync();
        try
        {
            var far = created.GetProperty("segmentCount").GetInt32() - 2;
            var requests = new List<Task<HttpResponseMessage>>();
            for (var i = 0; i < 10; i++)
            {
                requests.Add(raw.GetAsync($"{basePath}/{(i % 2 == 0 ? far : 1)}.m4s?p=1"));
                await Task.Delay(200);
            }
            // B17 before pacing: 9 restarts within 1.9 s.
            var burst = (await SessionAsync(admin, created)).GetProperty("restarts").GetInt32();
            Assert.InRange(burst, 2, 4);
            await Task.Delay(1500);
            var session = await SessionAsync(admin, created);
            Assert.Equal(1, session.GetProperty("job").GetProperty("startSegment").GetInt32());
            Assert.InRange(session.GetProperty("restarts").GetInt32(), burst, 5);
            foreach (var response in await Task.WhenAll(requests))
                response.Dispose();
        }
        finally
        {
            await raw.DeleteAsync(basePath);
        }
    }

    private static async Task<JsonElement> SessionAsync(HttpClient admin, JsonElement created)
        => (await admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions")).EnumerateArray()
            .Single(s => s.GetProperty("handle").GetString() == created.GetProperty("handle").GetString());

    [Fact]
    public void ASegmentThatVanishesWhileOpening_Answers503SegmentEvicted_WithRetryAfter()
    {
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        var result = Streamarr.Server.Transcoding.TranscodeStreamController.SegmentEvicted(context.Response);

        Assert.Equal(503, result.StatusCode);
        Assert.Equal("1", context.Response.Headers.RetryAfter.ToString());
        Assert.Equal("segment_evicted", Assert.IsType<Streamarr.Server.Contracts.ErrorResponse>(result.Value).Error.Code);
    }
}
