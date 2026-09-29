using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Transcoding;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>Viewer playback over the real HTTP pipeline: every state, decision and enforcement path with fake resolve and ffmpeg boundaries.</summary>
public sealed class ViewerPlaybackTests(ViewerPlaybackFactory factory) : IClassFixture<ViewerPlaybackFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private const string Base = "/api/v1/viewer/playback";
    private const string Movie = "tmdb-movie-501";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        factory.Resolver.Script = null;
        factory.Resolver.Repairs.Clear();
        factory.Media.FailModes.Clear();
        factory.Media.DeadStreams.Clear();
        factory.Media.Server = FakePlaybackMedia.Available();
        factory.Media.StartGate = null;
        factory.Media.ProbeGate = null;
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private static readonly object AppleTv = Device("tvos", vlc: false, Native(["mp4"], [Video("h264"), Video("hevc", 10, "hdr10", "hlg")], ["aac", "ac3", "eac3"], ["webvtt", "mov_text"], 6));
    private static readonly object AppleTvWithVlc = Device("tvos", vlc: true, Native(["mp4"], [Video("h264"), Video("hevc", 10, "hdr10", "hlg")], ["aac", "ac3", "eac3"], ["webvtt", "mov_text"], 6));
    private static readonly object Chrome = Device("web", vlc: false, new
    {
        engine = "web", hls = true, maxAudioChannels = 2, containers = new[] { "mp4", "webm" },
        videoCodecs = new[] { Video("h264"), Video("av1", 10) }, audioCodecs = new[] { new { codec = "aac" }, new { codec = "opus" } },
        subtitleFormats = new[] { "webvtt" },
    });

    private static object Device(string platform, bool vlc, params object[] engines) => new { platform, vlcAvailable = vlc, engines };

    private static object Native(string[] containers, object[] video, string[] audio, string[] subtitles, int channels)
        => new { engine = "native", hls = true, maxAudioChannels = channels, containers, videoCodecs = video, audioCodecs = audio.Select(a => new { codec = a }).ToArray(), subtitleFormats = subtitles };

    private static object Video(string codec, int? maxBitDepth = null, params string[] hdrFormats) => new { codec, maxBitDepth, hdrFormats };

    private static SourceMediaInfo Mp4() => TranscodeTestData.Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2);

    private static SourceMediaInfo Mkv(params SourceSubtitleStream[] subtitles)
        => TranscodeTestData.Media(container: "matroska,webm", audioCodec: "eac3", channels: 6, subtitles: subtitles);

    private static SourceMediaInfo Mpeg2() => TranscodeTestData.Media(codec: "mpeg2video", width: 720, height: 576, container: "mpeg", audioCodec: "ac3", channels: 2);

    private static SourceMediaInfo DualAudio() => Mkv() with
    {
        Audio =
        [
            new SourceAudioStream { Index = 1, Codec = "ac3", Channels = 6, Language = "ger", IsDefault = true, SampleRate = 48_000 },
            new SourceAudioStream { Index = 2, Codec = "ac3", Channels = 2, Language = "eng", SampleRate = 48_000 },
        ],
        Subtitles =
        [
            TranscodeTestData.Subtitle(3, "ass", "ger"),
            TranscodeTestData.Subtitle(4, "ass", "eng"),
            TranscodeTestData.Subtitle(5, "subrip", "ger", forced: true),
        ],
    };

    private string Release(SourceMediaInfo media, string workId = Movie, string title = "Catalog.Movie.2021.1080p.WEB-DL.DDP5.1.H.264-GRP")
    {
        var id = factory.Releases.Register(workId, title);
        factory.Media.Sources[id] = media;
        return id;
    }

    private async Task<(HttpClient Client, string Username)> ViewerAsync(string name, object? permissions = null, string device = "Living Room TV")
    {
        var (client, username, _) = await ViewerWithIdAsync(name, permissions, device);
        return (client, username);
    }

    private async Task<(HttpClient Client, string Username, string Id)> ViewerWithIdAsync(string name, object? permissions = null, string device = "Living Room TV")
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        var created = await ViewerApi.CreateAsync(_admin, new { username, password = Password, permissions });
        return (await DeviceAsync(username, device), username, created.GetProperty("viewer").GetProperty("id").GetString()!);
    }

    private async Task<HttpClient> DeviceAsync(string username, string device)
    {
        using var anon = factory.CreateClient();
        var login = await ViewerApi.LoginAsync(anon, username, Password, device);
        Assert.True(login.IsSuccessStatusCode, await login.Content.ReadAsStringAsync());
        var body = await login.Content.ReadFromJsonAsync<JsonElement>();
        return factory.Bearer(body.GetProperty("session").GetProperty("accessToken").GetString()!);
    }

    private static async Task<JsonElement> StartAsync(HttpClient client, object body, HttpStatusCode expected = HttpStatusCode.Accepted)
    {
        var response = await client.PostAsJsonAsync(Base, body);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == expected, $"expected {(int)expected}, got {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement;
    }

    private static object Play(string? releaseId, object device, object? preferences = null, long? start = null, int? audio = null, int? subtitle = null, string workId = Movie)
        => new { workId, releaseId, device, preferences, startPositionTicks = start, audioStreamIndex = audio, subtitleStreamIndex = subtitle };

    private static async Task<JsonElement> GetAsync(HttpClient client, string id, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var response = await client.GetAsync($"{Base}/{id}");
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == expected, $"expected {(int)expected}, got {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement;
    }

    private static async Task<JsonElement> WaitAsync(HttpClient client, string id, Func<JsonElement, bool>? until = null)
    {
        until ??= b => b.GetProperty("state").GetString() is "ready" or "failed";
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (true)
        {
            var body = await GetAsync(client, id);
            if (until(body))
                return body;
            Assert.True(DateTime.UtcNow < deadline, $"timed out waiting; last state: {body}");
            await Task.Delay(10);
        }
    }

    private static string State(JsonElement body) => body.GetProperty("state").GetString()!;

    private static string Id(JsonElement body) => body.GetProperty("playbackId").GetString()!;

    private static string[] Codes(JsonElement reasons) => reasons.EnumerateArray().Select(r => r.GetProperty("code").GetString()!).ToArray();

    private static JsonElement Error(JsonElement body) => body.GetProperty("error");

    private async Task<JsonElement> ReadyAsync(HttpClient client, object body)
    {
        var created = await StartAsync(client, body);
        var ready = await WaitAsync(client, Id(created));
        Assert.True(State(ready) == "ready", ready.ToString());
        return ready;
    }

    [Fact]
    public async Task Start_Answers202_ThenResolvesPlans_AndIsReadyForDirectPlay()
    {
        var (viewer, _) = await ViewerAsync("direct");
        var release = Release(Mp4());
        var hold = new TaskCompletionSource();
        factory.Resolver.Script = async (call, observer, ct) =>
        {
            observer.HopStarted(call.ReleaseId, 0);
            await hold.Task.WaitAsync(ct);
            observer.HopFinished(call.ReleaseId, "ready");
            return FakePlaybackResolver.Ready(call.ReleaseId);
        };

        var response = await viewer.PostAsJsonAsync(Base, Play(release, AppleTv, start: 42 * TimeSpan.TicksPerSecond));
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal((true, true, TimeSpan.Zero), (response.Headers.CacheControl!.Private, response.Headers.CacheControl.NoStore, response.Headers.CacheControl.MaxAge));
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal($"{Base}/{Id(created)}", response.Headers.Location?.AbsolutePath);
        Assert.Equal(0, created.GetProperty("revision").GetInt32());

        var resolving = await WaitAsync(viewer, Id(created), b => State(b) == "resolving" && b.GetProperty("attempts").GetArrayLength() == 1);
        Assert.Equal("resolving", resolving.GetProperty("attempts")[0].GetProperty("status").GetString());
        Assert.Equal(500, resolving.GetProperty("pollAfterMs").GetInt32());
        Assert.Equal(JsonValueKind.Null, resolving.GetProperty("url").ValueKind);
        factory.Media.ProbeGate = new TaskCompletionSource();
        hold.SetResult();
        var planning = await WaitAsync(viewer, Id(created), b => State(b) == "planning");
        Assert.Equal(release, planning.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.Equal(JsonValueKind.Null, planning.GetProperty("streamToken").ValueKind);
        factory.Media.ProbeGate.SetResult();

        var ready = await WaitAsync(viewer, Id(created));
        Assert.Equal("ready", State(ready));
        Assert.Equal(0, ready.GetProperty("pollAfterMs").GetInt32());
        Assert.Equal(("direct", "native"), (ready.GetProperty("method").GetString(), ready.GetProperty("engine").GetString()));
        Assert.Equal($"/api/v1/stream/{FakePlaybackResolver.Token(release)}", ready.GetProperty("url").GetString());
        Assert.Equal(FakePlaybackResolver.Token(release), ready.GetProperty("streamToken").GetString());
        Assert.Equal(42 * TimeSpan.TicksPerSecond, ready.GetProperty("startPositionTicks").GetInt64());
        Assert.Equal(release, ready.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.Equal("ready", ready.GetProperty("attempts")[0].GetProperty("status").GetString());
        Assert.Contains("direct_play", Codes(ready.GetProperty("decision").GetProperty("reasons")));
        var media = ready.GetProperty("mediaInfo");
        Assert.Equal("mp4", media.GetProperty("container").GetString());
        Assert.Equal(6_000_000_000L, media.GetProperty("durationTicks").GetInt64());
        Assert.Equal("original", media.GetProperty("audioTracks")[0].GetProperty("deliveredAs").GetString());
        Assert.True(media.GetProperty("audioTracks")[0].GetProperty("selected").GetBoolean());
        Assert.Equal(JsonValueKind.Null, ready.GetProperty("error").ValueKind);
        var call = Assert.Single(factory.Resolver.Calls, c => c.ReleaseId == release);
        Assert.True(call.AutoFallback);
        Assert.Equal(Movie, call.WorkId);
    }

    [Fact]
    public async Task MkvOnAppleTv_IsRemuxedIntoHls_WithTheEngineProfile_AtTheStartPosition()
    {
        var (viewer, _) = await ViewerAsync("remux");
        var release = Release(Mkv(TranscodeTestData.Subtitle(2, "subrip", "eng")));

        var ready = await ReadyAsync(viewer, Play(release, AppleTv, start: 90 * TimeSpan.TicksPerSecond));

        Assert.Equal(("remux", "native"), (ready.GetProperty("method").GetString(), ready.GetProperty("engine").GetString()));
        var started = factory.Media.Starts.Single(s => s.StreamToken == FakePlaybackResolver.Token(release));
        Assert.Equal($"/api/v1/transcode/{started.Id}/master.m3u8", ready.GetProperty("url").GetString());
        Assert.Equal(ModePreference.Remux, started.Mode);
        Assert.Equal(90, started.StartSeconds);
        Assert.Equal(["mp4"], started.Client.Containers);
        Assert.True(started.Client.Supports10Bit is false);
        Assert.Equal(6, started.Client.MaxAudioChannels);
        var reasons = Codes(ready.GetProperty("decision").GetProperty("reasons"));
        Assert.Contains("container_unsupported", reasons);
        Assert.Contains("audio_copied", reasons);
        var skipped = ready.GetProperty("decision").GetProperty("skipped");
        Assert.Equal("direct", skipped[0].GetProperty("method").GetString());
        Assert.Contains("container_unsupported", Codes(skipped[0].GetProperty("reasons")));
        var audio = ready.GetProperty("mediaInfo").GetProperty("audioTracks")[0];
        Assert.Equal(("copy", "eac3"), (audio.GetProperty("deliveredAs").GetString(), audio.GetProperty("deliveredCodec").GetString()));
        Assert.Equal("webvtt", ready.GetProperty("mediaInfo").GetProperty("subtitleTracks")[0].GetProperty("deliveredAs").GetString());
    }

    [Fact]
    public async Task RemuxThatCannotStart_FallsThroughToVlc_AndSaysWhy()
    {
        var (viewer, _) = await ViewerAsync("remuxfail");
        var release = Release(Mkv());
        factory.Media.FailModes[ModePreference.Remux] = "remux_not_possible";

        var ready = await ReadyAsync(viewer, Play(release, AppleTvWithVlc));

        Assert.Equal(("direct", "vlc"), (ready.GetProperty("method").GetString(), ready.GetProperty("engine").GetString()));
        Assert.Contains("vlc_fallback", Codes(ready.GetProperty("decision").GetProperty("reasons")));
        var skipped = ready.GetProperty("decision").GetProperty("skipped").EnumerateArray().ToList();
        Assert.Contains(skipped, s => s.GetProperty("method").GetString() == "remux" && Codes(s.GetProperty("reasons")).Contains("remux_not_possible"));
    }

    [Fact]
    public async Task AllHlsStartsFailing_Fails_WithTheStartErrorAndSuggestions()
    {
        var (viewer, _) = await ViewerAsync("hlsfail");
        var release = Release(Mpeg2());
        factory.Media.FailModes[ModePreference.Transcode] = "transcode_capacity";

        var created = await StartAsync(viewer, Play(release, Chrome));
        var failed = await WaitAsync(viewer, Id(created));

        Assert.Equal("failed", State(failed));
        Assert.Equal("transcode_capacity", Error(failed).GetProperty("code").GetString());
        Assert.Contains("retry", failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal(JsonValueKind.Null, failed.GetProperty("url").ValueKind);
    }

    [Fact]
    public async Task DeadRelease_FallsBack_AndTheAttemptsAndFallbackStateShowIt()
    {
        var (viewer, _) = await ViewerAsync("fallback");
        var dead = Release(Mp4(), title: "Catalog.Movie.2021.2160p.UHD.BluRay.TrueHD.Atmos.7.1.DV.HDR10.x265-GRP");
        var good = Release(Mp4());
        var hold = new TaskCompletionSource();
        factory.Resolver.Script = async (call, observer, ct) =>
        {
            observer.HopStarted(dead, 0);
            observer.HopFinished(dead, "dead");
            observer.HopStarted(good, 1);
            await hold.Task.WaitAsync(ct);
            observer.HopFinished(good, "ready");
            return FakePlaybackResolver.Ready(good) with
            {
                FallbackFromReleaseId = dead,
                Attempts = [new ResolveAttempt { ReleaseId = dead, Status = "dead" }, new ResolveAttempt { ReleaseId = good, Status = "ready" }],
            };
        };

        var created = await StartAsync(viewer, Play(dead, AppleTv));
        var fallback = await WaitAsync(viewer, Id(created), b => State(b) == "fallback");
        Assert.Equal(["dead", "resolving"], fallback.GetProperty("attempts").EnumerateArray().Select(a => a.GetProperty("status").GetString()));
        Assert.Equal(dead, fallback.GetProperty("fallbackFrom").GetProperty("releaseId").GetString());
        Assert.Equal("Catalog.Movie.2021.2160p.UHD.BluRay.TrueHD.Atmos.7.1.DV.HDR10.x265-GRP", fallback.GetProperty("fallbackFrom").GetProperty("name").GetString());
        hold.SetResult();

        var ready = await WaitAsync(viewer, Id(created));
        Assert.Equal("ready", State(ready));
        Assert.Equal([dead, good], ready.GetProperty("attempts").EnumerateArray().Select(a => a.GetProperty("releaseId").GetString()));
        Assert.Equal(["dead", "ready"], ready.GetProperty("attempts").EnumerateArray().Select(a => a.GetProperty("status").GetString()));
        Assert.Equal(good, ready.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.Equal(FakePlaybackResolver.Token(good), ready.GetProperty("streamToken").GetString());
        Assert.Contains("fallback_used", Codes(ready.GetProperty("decision").GetProperty("reasons")));
    }

    [Fact]
    public async Task DeadWithoutAWayOut_Fails_WithReleaseDead()
    {
        var (viewer, _) = await ViewerAsync("dead");
        var dead = Release(Mp4());
        factory.Resolver.Script = (call, observer, _) =>
        {
            observer.HopStarted(dead, 0);
            observer.HopFinished(dead, "dead");
            return Task.FromResult(new ResolveResponse { ReleaseId = dead, Status = "dead", Attempts = [new ResolveAttempt { ReleaseId = dead, Status = "dead" }] });
        };

        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(dead, AppleTv))));

        Assert.Equal("release_dead", Error(failed).GetProperty("code").GetString());
        Assert.Equal(dead, Error(failed).GetProperty("params").GetProperty("releaseId").GetString());
        Assert.False(Error(failed).GetProperty("params").TryGetProperty("suggestedReleaseId", out _));
        Assert.Equal(["otherVersion", "retry"], failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal("dead", failed.GetProperty("attempts")[0].GetProperty("status").GetString());
    }

    [Fact]
    public async Task Repair_ShowsProgressAndEta_ThenPlaysTheRepairedCopy()
    {
        var (viewer, _) = await ViewerAsync("repair");
        var release = Release(Mp4());
        var repair = new RepairStatusInfo { JobId = "job-1", Disposition = "repairable", State = "downloadingRecovery", Phase = "recovery", ProgressPercent = 40, EtaSeconds = 12, RetryAfterSeconds = 5 };
        factory.Resolver.Repairs[release] = repair;
        factory.Resolver.Script = (call, observer, _) =>
        {
            observer.HopStarted(release, 0);
            if (call.AutoFallback)
            {
                observer.HopFinished(release, "dead");
                return Task.FromResult(new ResolveResponse { ReleaseId = release, Status = "dead", Playability = "repairing", Repair = repair });
            }
            observer.HopFinished(release, "ready");
            return Task.FromResult(FakePlaybackResolver.Ready(release) with { OriginHealth = "dead", Playability = "repairedReady" });
        };

        var created = await StartAsync(viewer, Play(release, AppleTv));
        var repairing = await WaitAsync(viewer, Id(created), b => State(b) == "repairing");
        Assert.Equal(40, repairing.GetProperty("repair").GetProperty("progressPercent").GetInt32());
        Assert.Equal(12, repairing.GetProperty("repair").GetProperty("etaSeconds").GetDouble());
        Assert.Equal(5000, repairing.GetProperty("pollAfterMs").GetInt32());
        factory.Resolver.Repairs[release] = repair with { State = "ready", ProgressPercent = 100, EtaSeconds = null, RetryAfterSeconds = null };

        var ready = await WaitAsync(viewer, Id(created));
        Assert.Equal("ready", State(ready));
        Assert.Contains("repaired_copy", Codes(ready.GetProperty("decision").GetProperty("reasons")));
        Assert.Contains(factory.Resolver.Calls, c => c.ReleaseId == release && !c.AutoFallback);
    }

    [Fact]
    public async Task RepairFailure_Fails_WithRepairFailed()
    {
        var (viewer, _) = await ViewerAsync("repairfail");
        var release = Release(Mp4());
        var repair = new RepairStatusInfo { JobId = "job-2", Disposition = "repairable", State = "reconstructing", ProgressPercent = 70 };
        factory.Resolver.Repairs[release] = repair with { State = "failed", FailureReason = "insufficient parity" };
        factory.Resolver.Script = (call, observer, _)
            => Task.FromResult(new ResolveResponse { ReleaseId = release, Status = "dead", Playability = "repairing", Repair = repair });

        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(release, AppleTv))));

        Assert.Equal("repair_failed", Error(failed).GetProperty("code").GetString());
        Assert.Equal("insufficient parity", Error(failed).GetProperty("params").GetProperty("reason").GetString());
    }

    public static TheoryData<Exception, string, string> ResolveErrors => new()
    {
        { new ReleaseNotFoundException("x"), "release_not_found", "otherVersion" },
        { new NoPlayableFileException("no media"), "no_playable_file", "otherVersion" },
        { new HttpRequestException("indexer down"), "nzb_fetch_failed", "retry" },
        { new UsenetConnectionException("down"), "usenet_unreachable", "retry" },
        { new InvalidDataException("bad nzb"), "invalid_release", "otherVersion" },
        { new InvalidOperationException("boom"), "playback_failed", "retry" },
    };

    [Theory]
    [MemberData(nameof(ResolveErrors))]
    public async Task ResolveErrors_Fail_WithStableCodes(Exception error, string code, string suggestion)
    {
        var (viewer, _) = await ViewerAsync("errors");
        var release = Release(Mp4());
        factory.Resolver.Script = (_, _, _) => Task.FromException<ResolveResponse>(error);

        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(release, AppleTv))));

        Assert.Equal("failed", State(failed));
        Assert.Equal(code, Error(failed).GetProperty("code").GetString());
        Assert.Contains(suggestion, failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()));
        Assert.DoesNotContain("boom", Error(failed).GetProperty("message").GetString());
    }

    [Fact]
    public async Task BusyResolvePipeline_QueuesThePlayback_UntilASlotFrees()
    {
        var (viewer, _) = await ViewerAsync("queued");
        var release = Release(Mp4());
        var busy = 0;
        var free = new TaskCompletionSource();
        factory.Resolver.Script = (call, observer, _) =>
        {
            if (!free.Task.IsCompleted)
            {
                Interlocked.Increment(ref busy);
                return Task.FromException<ResolveResponse>(new ResourceCapacityException("The concurrent resolve limit has been reached."));
            }
            observer.HopStarted(call.ReleaseId, 0);
            observer.HopFinished(call.ReleaseId, "ready");
            return Task.FromResult(FakePlaybackResolver.Ready(call.ReleaseId));
        };

        var created = await StartAsync(viewer, Play(release, AppleTv));
        await WaitAsync(viewer, Id(created), b => State(b) == "queued");
        free.SetResult();
        var ready = await WaitAsync(viewer, Id(created));

        Assert.Equal("ready", State(ready));
        Assert.True(busy >= 1);
    }

    [Fact]
    public async Task ResolvePipelineBusyForTooLong_Fails_WithCapacityReached()
    {
        var (viewer, _) = await ViewerAsync("capacity");
        var release = Release(Mp4());
        factory.Resolver.Script = (_, _, _) => Task.FromException<ResolveResponse>(new ResourceCapacityException("full"));

        var created = await StartAsync(viewer, Play(release, AppleTv));
        await WaitAsync(viewer, Id(created), b => State(b) == "queued");
        factory.Clock.Advance(ViewerPlaybackFactory.Timings.CapacityWait + TimeSpan.FromSeconds(1));
        var failed = await WaitAsync(viewer, Id(created));

        Assert.Equal("capacity_reached", Error(failed).GetProperty("code").GetString());
        Assert.Equal(["retry"], failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()));
    }

    [Fact]
    public async Task WithoutReleaseId_TheRecommendedVersionPlays()
    {
        var (viewer, _) = await ViewerAsync("recommended");
        var versions = await viewer.GetFromJsonAsync<JsonElement>($"/api/v1/viewer/catalog/works/{Movie}/versions");
        var recommended = versions.GetProperty("versions")[0].GetProperty("releaseId").GetString()!;

        var ready = await ReadyAsync(viewer, Play(null, AppleTv));

        Assert.Equal(recommended, ready.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.Equal(1, ready.GetProperty("version").GetProperty("rank").GetInt32());
        Assert.True(ready.GetProperty("version").GetProperty("recommended").GetBoolean());
    }

    [Fact]
    public async Task VersionIsRankedFromTheCachedList_WithoutAnIndexerSearch()
    {
        var (viewer, _) = await ViewerAsync("ranked");
        var versions = await viewer.GetFromJsonAsync<JsonElement>($"/api/v1/viewer/catalog/works/{Movie}/versions");
        var second = versions.GetProperty("versions")[1].GetProperty("releaseId").GetString()!;
        var searches = factory.Newznab.Searches;

        var ready = await ReadyAsync(viewer, Play(second, AppleTv));

        Assert.Equal(2, ready.GetProperty("version").GetProperty("rank").GetInt32());
        Assert.Equal(searches, factory.Newznab.Searches);
    }

    [Fact]
    public async Task ReleaseOfAnotherWork_Fails_WithReleaseNotFound()
    {
        var (viewer, _) = await ViewerAsync("otherwork");
        var foreign = Release(Mp4(), workId: "tmdb-movie-504");

        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(foreign, AppleTv))));

        Assert.Equal("release_not_found", Error(failed).GetProperty("code").GetString());
        Assert.DoesNotContain(factory.Resolver.Calls, c => c.ReleaseId == foreign);
    }

    [Fact]
    public async Task AgeGate_Answers403_BeforeAnyWork()
    {
        var (kid, _) = await ViewerAsync("kid", new { maxAge = 12, blockUnrated = true });
        var calls = factory.Resolver.Calls.Count;

        var rated = await StartAsync(kid, Play(null, AppleTv, workId: "tmdb-movie-502"), HttpStatusCode.Forbidden);
        var unrated = await StartAsync(kid, Play(null, AppleTv, workId: "tmdb-movie-503"), HttpStatusCode.Forbidden);

        Assert.Equal("age_restricted", Error(rated).GetProperty("code").GetString());
        Assert.Equal("above_age_limit", Error(rated).GetProperty("params").GetProperty("reason").GetString());
        Assert.Equal("R", Error(rated).GetProperty("params").GetProperty("rating").GetString());
        Assert.Equal("unrated_blocked", Error(unrated).GetProperty("params").GetProperty("reason").GetString());
        Assert.Equal(calls, factory.Resolver.Calls.Count);
        await ReadyAsync(kid, Play(Release(Mp4(), workId: "tmdb-movie-504", title: "Kids.Movie.2018.1080p.WEB-DL.AAC2.0.H.264-GRP"), AppleTv, workId: "tmdb-movie-504"));
    }

    [Fact]
    public async Task WithoutTranscoding_FullTranscodesFail_ButRemuxStaysAllowed()
    {
        var (guest, _) = await ViewerAsync("guest", new { allowTranscoding = false });

        var failed = await WaitAsync(guest, Id(await StartAsync(guest, Play(Release(Mpeg2()), Chrome))));
        var remux = await ReadyAsync(guest, Play(Release(Mkv()), AppleTv));

        Assert.Equal("transcoding_not_allowed", Error(failed).GetProperty("code").GetString());
        Assert.Equal(["otherVersion"], failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()));
        var skipped = failed.GetProperty("decision").GetProperty("skipped").EnumerateArray().ToList();
        Assert.Contains(skipped, s => s.GetProperty("method").GetString() == "transcode" && Codes(s.GetProperty("reasons")).Contains("transcoding_not_allowed"));
        Assert.Contains(skipped, s => s.GetProperty("method").GetString() == "remux" && Codes(s.GetProperty("reasons")).Contains("video_codec_not_remuxable"));
        Assert.Equal("remux", remux.GetProperty("method").GetString());
    }

    [Fact]
    public async Task ServerTranscodingDisabled_LeavesDirectPlayOnly()
    {
        var (viewer, _) = await ViewerAsync("disabled");
        factory.Media.Server = FakePlaybackMedia.Available(enabled: false);

        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(Release(Mkv()), AppleTv))));
        var vlc = await ReadyAsync(viewer, Play(Release(Mkv()), AppleTvWithVlc));
        var direct = await ReadyAsync(viewer, Play(Release(Mp4()), AppleTv));

        Assert.Equal("transcoding_unavailable", Error(failed).GetProperty("code").GetString());
        Assert.Equal("transcoding_disabled", Error(failed).GetProperty("params").GetProperty("reason").GetString());
        Assert.Equal(("direct", "vlc"), (vlc.GetProperty("method").GetString(), vlc.GetProperty("engine").GetString()));
        Assert.Equal("direct", direct.GetProperty("method").GetString());
    }

    [Fact]
    public async Task UnreadableSource_PlaysDirectWithVlc_OrFailsWithProbeFailed()
    {
        var (viewer, _) = await ViewerAsync("probe");
        var unreadable = Release(null!);
        factory.Media.Sources[unreadable] = null;

        var vlc = await ReadyAsync(viewer, Play(unreadable, AppleTvWithVlc));
        var failed = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(unreadable, AppleTv))));

        Assert.Equal(("direct", "vlc"), (vlc.GetProperty("method").GetString(), vlc.GetProperty("engine").GetString()));
        Assert.Contains("probe_failed", Codes(vlc.GetProperty("decision").GetProperty("reasons")));
        Assert.Equal("probe_failed", Error(failed).GetProperty("code").GetString());
    }

    [Fact]
    public async Task StreamLimit_AnotherDeviceGets409NamingTheFirst_UntilItStops()
    {
        var (tv, username) = await ViewerAsync("limit", new { maxConcurrentStreams = 1 }, device: "Living Room TV");
        using var phone = await DeviceAsync(username, "Kitchen Phone");
        var release = Release(Mp4());
        var first = await ReadyAsync(tv, Play(release, AppleTv));

        var conflict = await StartAsync(phone, Play(release, Chrome), HttpStatusCode.Conflict);

        Assert.Equal("too_many_streams", Error(conflict).GetProperty("code").GetString());
        var parameters = Error(conflict).GetProperty("params");
        Assert.Equal("Living Room TV", parameters.GetProperty("device").GetString());
        Assert.Equal("1", parameters.GetProperty("limit").GetString());
        Assert.Equal(Movie, parameters.GetProperty("workId").GetString());
        Assert.Equal("Catalog.Movie.2021.1080p.WEB-DL.DDP5.1.H.264-GRP", parameters.GetProperty("releaseName").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await tv.PostAsync($"{Base}/{Id(first)}/stop", null)).StatusCode);
        await ReadyAsync(phone, Play(release, Chrome));
    }

    [Fact]
    public async Task StreamLimit_TheSameDeviceReplacesItsOwnPlayback()
    {
        var (tv, _) = await ViewerAsync("replace", new { maxConcurrentStreams = 1 });
        var first = await ReadyAsync(tv, Play(Release(Mkv()), AppleTv));
        var firstHls = factory.Media.Starts.Last().Id;

        var second = await ReadyAsync(tv, Play(Release(Mp4()), AppleTv));

        await GetAsync(tv, Id(first), HttpStatusCode.NotFound);
        Assert.Equal("ready", State(second));
        Assert.Contains(firstHls, factory.Media.Closed);
    }

    [Fact]
    public async Task StreamLimit_CountsOnlyPlaybacksWithARecentHeartbeat()
    {
        var (tv, username) = await ViewerAsync("heartbeat", new { maxConcurrentStreams = 1 });
        using var phone = await DeviceAsync(username, "Phone");
        var release = Release(Mp4());
        var first = await ReadyAsync(tv, Play(release, AppleTv));

        factory.Clock.Advance(TimeSpan.FromSeconds(50));
        var progress = await tv.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = Movie, positionTicks = 100_000_000L, playbackId = Id(first) });
        Assert.Equal(HttpStatusCode.OK, progress.StatusCode);
        factory.Clock.Advance(TimeSpan.FromSeconds(50));
        await StartAsync(phone, Play(release, Chrome), HttpStatusCode.Conflict);

        factory.Clock.Advance(TimeSpan.FromSeconds(11));
        var second = await ReadyAsync(phone, Play(release, Chrome));
        Assert.Equal("ready", State(second));
        Assert.Equal("ready", State(await GetAsync(tv, Id(first))));
    }

    [Fact]
    public async Task FailedPlaybacks_DoNotHoldTheStreamSlot()
    {
        var (tv, username) = await ViewerAsync("failedslot", new { maxConcurrentStreams = 1, allowTranscoding = false });
        using var phone = await DeviceAsync(username, "Phone");
        var failed = await WaitAsync(tv, Id(await StartAsync(tv, Play(Release(Mpeg2()), Chrome))));
        Assert.Equal("failed", State(failed));

        await ReadyAsync(phone, Play(Release(Mp4()), Chrome));
    }

    [Fact]
    public async Task Playbacks_BelongToOneDevice_OthersGet404()
    {
        var (tv, username) = await ViewerAsync("owner");
        using var phone = await DeviceAsync(username, "Phone");
        var (stranger, _) = await ViewerAsync("stranger");
        var ready = await ReadyAsync(tv, Play(Release(Mp4()), AppleTv));
        var id = Id(ready);

        foreach (var other in new[] { phone, stranger })
        {
            await GetAsync(other, id, HttpStatusCode.NotFound);
            Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsJsonAsync($"{Base}/{id}/switch", new { audioStreamIndex = 1 })).StatusCode);
            var stop = await other.PostAsync($"{Base}/{id}/stop", null);
            Assert.Equal(HttpStatusCode.NotFound, stop.StatusCode);
            Assert.Equal("playback_not_found", await ViewerApi.ErrorCodeAsync(stop));
            var progress = await other.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = Movie, positionTicks = 10L, playbackId = id });
            Assert.Equal(HttpStatusCode.OK, progress.StatusCode);
            Assert.Equal(JsonValueKind.Null, (await progress.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("lastReleaseId").ValueKind);
        }
        Assert.Equal("ready", State(await GetAsync(tv, id)));
        await GetAsync(tv, "missing-playback", HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Switch_ReplansWithOtherTracks_AndKeepsThePreviousUrlForAGracePeriod()
    {
        var (viewer, _) = await ViewerAsync("switch");
        var release = Release(DualAudio());
        var ready = await ReadyAsync(viewer, Play(release, AppleTv, new { audioLanguage = "de", subtitleMode = "forced" }));
        var firstHls = factory.Media.Starts.Last().Id;
        Assert.True(ready.GetProperty("mediaInfo").GetProperty("audioTracks")[0].GetProperty("selected").GetBoolean());
        Assert.True(ready.GetProperty("mediaInfo").GetProperty("subtitleTracks")[2].GetProperty("selected").GetBoolean());

        var response = await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { positionTicks = 600_000_000L, audioStreamIndex = 2, subtitleStreamIndex = 4 });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var switched = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, switched.GetProperty("revision").GetInt32());
        Assert.NotEqual("ready", State(switched));

        var again = await WaitAsync(viewer, Id(ready));
        Assert.Equal("ready", State(again));
        var started = factory.Media.Starts.Last();
        Assert.NotEqual(firstHls, started.Id);
        Assert.Equal((2, 4, 60d), (started.Limits.AudioStreamIndex, started.Limits.SubtitleStreamIndex, started.StartSeconds));
        Assert.Equal(600_000_000L, again.GetProperty("startPositionTicks").GetInt64());
        var audio = again.GetProperty("mediaInfo").GetProperty("audioTracks");
        Assert.True(audio[1].GetProperty("selected").GetBoolean());
        Assert.Equal("copy", audio[1].GetProperty("deliveredAs").GetString());
        Assert.Equal("none", audio[0].GetProperty("deliveredAs").GetString());
        Assert.True(again.GetProperty("mediaInfo").GetProperty("subtitleTracks")[1].GetProperty("selected").GetBoolean());
        Assert.Single(factory.Resolver.Calls, c => c.ReleaseId == release);

        await factory.Playbacks.SweepAsync();
        Assert.DoesNotContain(firstHls, factory.Media.Closed);
        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        await factory.Playbacks.SweepAsync();
        Assert.Contains(firstHls, factory.Media.Closed);
        Assert.DoesNotContain(started.Id, factory.Media.Closed);
    }

    [Fact]
    public async Task Switch_RechecksTheAgeGate_AndTheCurrentTranscodingPermission()
    {
        var (viewer, _, id) = await ViewerWithIdAsync("recheck");
        var rated = await ReadyAsync(viewer, Play(Release(Mkv(), workId: "tmdb-movie-502"), AppleTv, workId: "tmdb-movie-502"));
        var mkv = await ReadyAsync(viewer, Play(Release(Mkv(), workId: "tmdb-movie-504", title: "Kids.Movie.2018.1080p.WEB-DL.DDP5.1.H.264-GRP"), AppleTv, workId: "tmdb-movie-504"));
        var patched = await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{id}", new { permissions = new { maxAge = 12, allowTranscoding = false } });
        Assert.True(patched.IsSuccessStatusCode, await patched.Content.ReadAsStringAsync());

        var blocked = await viewer.PostAsJsonAsync($"{Base}/{Id(rated)}/switch", new { audioStreamIndex = 1 });
        var lowered = await viewer.PostAsJsonAsync($"{Base}/{Id(mkv)}/switch", new { preferences = new { maxHeight = 720 } });

        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.Equal("age_restricted", await ViewerApi.ErrorCodeAsync(blocked));
        Assert.Equal(HttpStatusCode.Accepted, lowered.StatusCode);
        var failed = await WaitAsync(viewer, Id(mkv), b => b.GetProperty("revision").GetInt32() == 1 && State(b) is "ready" or "failed");
        Assert.Equal("transcoding_not_allowed", Error(failed).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Switch_ToAnotherVersion_ResolvesAgain()
    {
        var (viewer, _) = await ViewerAsync("switchrelease");
        var first = Release(Mp4());
        var second = Release(Mkv(), title: "Catalog.Movie.2021.1080p.WEB-DL.Opus.5.1.AV1-GRP");
        var ready = await ReadyAsync(viewer, Play(first, AppleTv));

        var response = await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { releaseId = second });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var again = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 1 && State(b) is "ready" or "failed");

        Assert.Equal(second, again.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.Equal(FakePlaybackResolver.Token(second), again.GetProperty("streamToken").GetString());
        Assert.Equal([second], again.GetProperty("attempts").EnumerateArray().Select(a => a.GetProperty("releaseId").GetString()));
        Assert.Equal("remux", again.GetProperty("method").GetString());
    }

    [Fact]
    public async Task Switch_StepDown_ContinuesWithTheNextMethod_UntilNoneIsLeft()
    {
        var (viewer, _) = await ViewerAsync("stepdown");
        var ready = await ReadyAsync(viewer, Play(Release(Mkv()), AppleTvWithVlc));
        Assert.Equal("remux", ready.GetProperty("method").GetString());

        await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { stepDown = true });
        var vlc = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 1 && State(b) is "ready" or "failed");
        Assert.Equal(("direct", "vlc"), (vlc.GetProperty("method").GetString(), vlc.GetProperty("engine").GetString()));

        await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { stepDown = true });
        var transcode = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 2 && State(b) is "ready" or "failed");
        Assert.Equal("transcode", transcode.GetProperty("method").GetString());
        Assert.Contains("step_down", transcode.GetProperty("decision").GetProperty("skipped").EnumerateArray().SelectMany(s => Codes(s.GetProperty("reasons"))));

        await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { stepDown = true });
        var none = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 3 && State(b) is "ready" or "failed");
        Assert.Equal("no_more_methods", Error(none).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Switch_WhilePreparing_SupersedesTheOldRevision()
    {
        var (viewer, _) = await ViewerAsync("supersede");
        var release = Release(Mkv());
        factory.Media.StartGate = new TaskCompletionSource();
        var created = await StartAsync(viewer, Play(release, AppleTv));
        await WaitAsync(viewer, Id(created), b => State(b) == "starting");

        var response = await viewer.PostAsJsonAsync($"{Base}/{Id(created)}/switch", new { preferences = new { maxHeight = 720 } });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        factory.Media.StartGate.SetResult();
        var ready = await WaitAsync(viewer, Id(created), b => b.GetProperty("revision").GetInt32() == 1 && State(b) is "ready" or "failed");

        Assert.Equal("transcode", ready.GetProperty("method").GetString());
        Assert.Equal(720, ready.GetProperty("mediaInfo").GetProperty("video").GetProperty("deliveredHeight").GetInt32());
        var remux = factory.Media.Starts.Single(s => s.StreamToken == FakePlaybackResolver.Token(release) && s.Mode == ModePreference.Remux);
        await WaitUntilAsync(() => factory.Media.Closed.Contains(remux.Id));
    }

    [Fact]
    public async Task RapidSwitches_OnlyTheLastRevisionPlays_AndEveryLateSessionIsClosed()
    {
        var (viewer, _) = await ViewerAsync("rapid");
        var release = Release(DualAudio());
        var ready = await ReadyAsync(viewer, Play(release, AppleTv));
        factory.Media.StartGate = new TaskCompletionSource();

        var switches = await Task.WhenAll(
            viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { audioStreamIndex = 2 }),
            viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { audioStreamIndex = 1, subtitleStreamIndex = 4 }),
            viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { subtitleStreamIndex = -1 }));
        Assert.All(switches, r => Assert.Equal(HttpStatusCode.Accepted, r.StatusCode));
        factory.Media.StartGate.SetResult();
        var last = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 3 && State(b) is "ready" or "failed");
        Assert.Equal("ready", State(last));
        await WaitUntilAsync(() => factory.Media.Starts.Count(s => s.StreamToken == FakePlaybackResolver.Token(release)) >= 2);

        Assert.Equal(HttpStatusCode.NoContent, (await viewer.PostAsync($"{Base}/{Id(ready)}/stop", null)).StatusCode);
        var started = factory.Media.Starts.Where(s => s.StreamToken == FakePlaybackResolver.Token(release)).Select(s => s.Id).ToList();
        await WaitUntilAsync(() => started.All(factory.Media.Closed.Contains));
    }

    [Fact]
    public async Task Switch_AfterTheStreamExpired_ResolvesAgain()
    {
        var (viewer, _) = await ViewerAsync("expired");
        var release = Release(Mp4());
        var ready = await ReadyAsync(viewer, Play(release, AppleTv));
        factory.Media.DeadStreams.Add(FakePlaybackResolver.Token(release));
        factory.Resolver.Script = (call, observer, _) =>
        {
            factory.Media.DeadStreams.Clear();
            return Task.FromResult(FakePlaybackResolver.Ready(call.ReleaseId));
        };

        await viewer.PostAsJsonAsync($"{Base}/{Id(ready)}/switch", new { audioStreamIndex = 1 });
        var again = await WaitAsync(viewer, Id(ready), b => b.GetProperty("revision").GetInt32() == 1 && State(b) is "ready" or "failed");

        Assert.Equal("ready", State(again));
        Assert.Equal(2, factory.Resolver.Calls.Count(c => c.ReleaseId == release));
    }

    [Fact]
    public async Task Stop_EndsTheSessions_AndForgetsThePlayback()
    {
        var (viewer, _) = await ViewerAsync("stop");
        var ready = await ReadyAsync(viewer, Play(Release(Mkv()), AppleTv));
        var hls = factory.Media.Starts.Last().Id;

        var stop = await viewer.PostAsync($"{Base}/{Id(ready)}/stop", null);

        Assert.Equal(HttpStatusCode.NoContent, stop.StatusCode);
        Assert.Contains(hls, factory.Media.Closed);
        await GetAsync(viewer, Id(ready), HttpStatusCode.NotFound);
        Assert.Equal(HttpStatusCode.NotFound, (await viewer.PostAsync($"{Base}/{Id(ready)}/stop", null)).StatusCode);
    }

    [Fact]
    public async Task Stop_WhileStarting_ClosesTheSessionThatStartsLate()
    {
        var (viewer, _) = await ViewerAsync("stoplate");
        var release = Release(Mkv());
        factory.Media.StartGate = new TaskCompletionSource();
        var created = await StartAsync(viewer, Play(release, AppleTv));
        await WaitAsync(viewer, Id(created), b => State(b) == "starting");

        Assert.Equal(HttpStatusCode.NoContent, (await viewer.PostAsync($"{Base}/{Id(created)}/stop", null)).StatusCode);
        factory.Media.StartGate.SetResult();

        await WaitUntilAsync(() => factory.Media.Starts.Any(s => s.StreamToken == FakePlaybackResolver.Token(release)));
        var late = factory.Media.Starts.Single(s => s.StreamToken == FakePlaybackResolver.Token(release));
        await WaitUntilAsync(() => factory.Media.Closed.Contains(late.Id));
    }

    [Fact]
    public async Task IdlePlaybacks_Expire_AndPollsKeepThemAlive()
    {
        var (viewer, _) = await ViewerAsync("idle");
        var kept = await ReadyAsync(viewer, Play(Release(Mp4()), AppleTv));
        var idle = await ReadyAsync(viewer, Play(Release(Mkv()), AppleTv));
        var hls = factory.Media.Starts.Last().Id;

        factory.Clock.Advance(TimeSpan.FromSeconds(400));
        await GetAsync(viewer, Id(kept));
        factory.Clock.Advance(TimeSpan.FromSeconds(201));
        await factory.Playbacks.SweepAsync();

        await GetAsync(viewer, Id(idle), HttpStatusCode.NotFound);
        Assert.Contains(hls, factory.Media.Closed);
        Assert.Equal("ready", State(await GetAsync(viewer, Id(kept))));
    }

    [Fact]
    public async Task WatchProgress_WithAPlaybackId_FillsReleaseAndToken_KeepsItAlive_AndStopEndsIt()
    {
        var (viewer, _) = await ViewerAsync("progress");
        var release = Release(Mkv());
        var ready = await ReadyAsync(viewer, Play(release, AppleTv));
        var hls = factory.Media.Starts.Last().Id;

        var progress = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
            new { @event = "progress", workId = Movie, positionTicks = 1_200_000_000L, durationTicks = 6_000_000_000L, playbackId = Id(ready) });
        Assert.Equal(HttpStatusCode.OK, progress.StatusCode);
        Assert.Equal(release, (await progress.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("lastReleaseId").GetString());
        Assert.Contains(hls, factory.Media.Touched);
        var events = await _admin.GetFromJsonAsync<JsonElement>("/api/v1/events?limit=50");
        var forwarded = events.EnumerateArray().First(e => e.GetProperty("playbackSessionId").GetString() == Id(ready));
        Assert.Equal("streamarr-viewer", forwarded.GetProperty("source").GetString());
        Assert.Equal(FakePlaybackResolver.Token(release), forwarded.GetProperty("sessionToken").GetString());
        Assert.Equal(release, forwarded.GetProperty("releaseId").GetString());

        var otherWork = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress", new { @event = "progress", workId = "tmdb-movie-504", positionTicks = 5L, playbackId = Id(ready) });
        Assert.Equal(JsonValueKind.Null, (await otherWork.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("lastReleaseId").ValueKind);

        var stop = await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
            new { @event = "stop", workId = Movie, positionTicks = 1_300_000_000L, durationTicks = 6_000_000_000L, playbackId = Id(ready) });
        Assert.Equal(HttpStatusCode.OK, stop.StatusCode);
        await GetAsync(viewer, Id(ready), HttpStatusCode.NotFound);
        Assert.Contains(hls, factory.Media.Closed);
    }

    [Fact]
    public async Task ResumePosition_ComesFromTheWatchState()
    {
        var (viewer, _) = await ViewerAsync("resume");
        await viewer.PostAsJsonAsync("/api/v1/viewer/watch/progress",
            new { @event = "progress", workId = Movie, positionTicks = 36_000_000_000L, durationTicks = 72_000_000_000L });

        var created = await StartAsync(viewer, Play(Release(Mp4()), AppleTv));

        Assert.Equal(36_000_000_000L, created.GetProperty("resumePositionTicks").GetInt64());
        Assert.Equal(0, created.GetProperty("startPositionTicks").GetInt64());
    }

    public static TheoryData<string, string> InvalidRequests => new()
    {
        { """{"device":{"platform":"tvos","engines":[{"engine":"native"}]}}""", "invalid_work_id" },
        { """{"workId":"tmdb-tv-600","device":{"platform":"tvos","engines":[{"engine":"native"}]}}""", "invalid_work_id" },
        { """{"workId":"tmdb-movie-501"}""", "invalid_device_profile" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"toaster","engines":[{"engine":"native"}]}}""", "invalid_device_profile" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[]}}""", "invalid_device_profile" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"quicktime"}]}}""", "invalid_device_profile" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native","videoCodecs":[{"codec":"h 264"}]}]}}""", "invalid_device_profile" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"preferences":{"engine":"mpv"}}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"preferences":{"subtitleMode":"sometimes"}}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"preferences":{"maxHeight":10}}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"preferences":{"audioLanguage":"klingon-empire"}}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"startPositionTicks":-1}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"subtitleStreamIndex":-2}""", "invalid_playback_request" },
        { """{"workId":"tmdb-movie-501","device":{"platform":"tvos","engines":[{"engine":"native"}]},"startPositionTicks":"soon"}""", "invalid_request" },
    };

    [Theory]
    [MemberData(nameof(InvalidRequests))]
    public async Task InvalidRequests_Answer400_WithTheErrorEnvelope(string json, string code)
    {
        var (viewer, _) = await ViewerAsync("invalid");

        var response = await viewer.PostAsync(Base, new StringContent(json, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(code, await ViewerApi.ErrorCodeAsync(response));
    }

    [Fact]
    public async Task UnknownTrackIndexes_Fail_WithStableCodes()
    {
        var (viewer, _) = await ViewerAsync("tracks");

        var audio = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(Release(Mp4()), AppleTv, audio: 9))));
        var subtitle = await WaitAsync(viewer, Id(await StartAsync(viewer, Play(Release(Mp4()), AppleTv, subtitle: 9))));

        Assert.Equal("unknown_audio_stream", Error(audio).GetProperty("code").GetString());
        Assert.Equal("unknown_subtitle_stream", Error(subtitle).GetProperty("code").GetString());
    }

    [Fact]
    public async Task OnlyViewerSessions_WhileTheModuleIsOn_MayUseIt()
    {
        var body = Play(null, AppleTv);
        using var anonymous = factory.CreateClient();
        using var machine = factory.Bearer(ViewerPlaybackFactory.ApiKey);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync(Base, body)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _admin.PostAsJsonAsync(Base, body)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await machine.GetAsync($"{Base}/abc")).StatusCode);

        var (mustChange, _) = await ViewerAsync("mustchange");
        var username = $"pending-{Guid.NewGuid():N}"[..24];
        await ViewerApi.CreateAsync(_admin, new { username, password = Password, mustChangePassword = true });
        using var pending = await DeviceAsync(username, "Pending TV");
        var blocked = await pending.PostAsJsonAsync(Base, body);
        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.Equal("password_change_required", await ViewerApi.ErrorCodeAsync(blocked));

        await ViewerApi.ConfigureAsync(_admin, new { enabled = false });
        try
        {
            var off = await mustChange.GetAsync($"{Base}/abc");
            Assert.Equal(HttpStatusCode.NotFound, off.StatusCode);
            Assert.Equal("module_disabled", await ViewerApi.ErrorCodeAsync(off));
        }
        finally
        {
            await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "condition not met in time");
            await Task.Delay(10);
        }
    }
}
