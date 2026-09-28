using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>
/// A realistic Usenet provider scaled down in bytes but not in behaviour: 40 ms per command, ~1 s of media per article and
/// 0.25 s to transfer one article on one connection (like 750 KB articles at 3 MB/s for a 6 Mbps release).
/// </summary>
public sealed class TranscodingTtffFixture : TranscodingServerFixture
{
    public const int Copies = 4;
    public const int Seconds = 150;

    protected override TimeSpan NntpLatency => TimeSpan.FromMilliseconds(40);
    protected override int NntpBytesPerSecondPerConnection => 800 * 1024;
    protected override int SourceDurationSeconds => Seconds;
    protected override string SourceSize => "1920x1080";
    protected override string SourceVideoBitrate => "1500k";
    protected override int ArticleBytes => 200_000;
    protected override int ReleaseCopies => Copies;
}

[CollectionDefinition("transcoding-ttff", DisableParallelization = true)]
public class TranscodingTtffCollection : ICollectionFixture<TranscodingTtffFixture>;

/// <summary>
/// Measures time to first frame for direct play and for the transcode path on cold releases, and guards the parts the
/// transcoder adds (probe, ffmpeg start, first segment) against regressions.
/// </summary>
[Collection("transcoding-ttff")]
public sealed class TranscodingTtffTests(TranscodingTtffFixture fixture, ITestOutputHelper output)
{
    [Fact]
    public async Task TranscodeStartup_AddsOnlyProbeFfmpegStartAndOneSegment_OnTopOfDirectPlay()
    {
        using var client = fixture.CreateClient();
        using var admin = await fixture.CreateAdminClientAsync();
        var segmentSeconds = int.TryParse(Environment.GetEnvironmentVariable("STREAMARR_TTFF_SEGMENT_SECONDS"), out var configured) ? configured : 4;
        (await admin.PutAsJsonAsync("/api/v1/transcoding/config", new { enabled = true, acceleration = "none", segmentLengthSeconds = segmentSeconds }))
            .EnsureSuccessStatusCode();
        output.WriteLine($"segment length {segmentSeconds} s");

        var direct = await MeasureDirectAsync(client, copy: 0, fromSecond: 0);
        var transcode = await MeasureTranscodeAsync(client, admin, copy: 1, fromSecond: 0);
        var directResume = await MeasureDirectAsync(client, copy: 2, fromSecond: 120);
        var transcodeResume = await MeasureTranscodeAsync(client, admin, copy: 3, fromSecond: 120);

        output.WriteLine("cold start      | resolve | first media | total");
        output.WriteLine($"direct play     | {direct.ResolveMs,7:0} | {direct.MediaMs,11:0} | {direct.TotalMs,5:0}  ({direct.Detail})");
        output.WriteLine($"transcode (HLS) | {transcode.ResolveMs,7:0} | {transcode.MediaMs,11:0} | {transcode.TotalMs,5:0}  ({transcode.Detail})");
        output.WriteLine($"direct @120s    | {directResume.ResolveMs,7:0} | {directResume.MediaMs,11:0} | {directResume.TotalMs,5:0}  ({directResume.Detail})");
        output.WriteLine($"transcode @120s | {transcodeResume.ResolveMs,7:0} | {transcodeResume.MediaMs,11:0} | {transcodeResume.TotalMs,5:0}  ({transcodeResume.Detail})");

        Assert.InRange(transcode.MediaMs - direct.MediaMs, -1_000, 6_000);
        Assert.InRange(transcodeResume.MediaMs, 0, 8_000);
    }

    private sealed record Measurement(double ResolveMs, double MediaMs, string Detail)
    {
        public double TotalMs => ResolveMs + MediaMs;
    }

    /// <summary>ffmpeg as a direct-play client: probe, seek through the index, decode the first frame at the target.</summary>
    private async Task<Measurement> MeasureDirectAsync(HttpClient client, int copy, int fromSecond)
    {
        var clock = Stopwatch.StartNew();
        var token = await fixture.ResolveStreamTokenAsync(client, copy);
        var resolveMs = clock.Elapsed.TotalMilliseconds;
        var afterResolve = fixture.BodiesServed(copy);

        var start = clock.Elapsed.TotalMilliseconds;
        var psi = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in new[]
                 {
                     "-hide_banner", "-v", "error", "-ss", fromSecond.ToString(System.Globalization.CultureInfo.InvariantCulture),
                     "-i", $"{fixture.BaseUrl}/api/v1/stream/{token}", "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-",
                 })
        {
            psi.ArgumentList.Add(argument);
        }
        using (var process = Process.Start(psi)!)
        {
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            Assert.True(process.ExitCode == 0, stderr);
        }
        var media = clock.Elapsed.TotalMilliseconds - start;
        var afterMedia = fixture.BodiesServed(copy);
        await client.PostAsync($"/api/v1/sessions/{token}/close", null);
        return new Measurement(resolveMs, media,
            $"first decoded frame {media:0} ms, articles resolve {afterResolve} + playback {afterMedia - afterResolve}");
    }

    private async Task<Measurement> MeasureTranscodeAsync(HttpClient client, HttpClient admin, int copy, int fromSecond)
    {
        var clock = Stopwatch.StartNew();
        var token = await fixture.ResolveStreamTokenAsync(client, copy);
        var resolveMs = clock.Elapsed.TotalMilliseconds;
        var afterResolve = fixture.BodiesServed(copy);

        var start = clock.Elapsed.TotalMilliseconds;
        var created = await client.PostAsJsonAsync("/api/v1/transcoding/sessions",
            new { streamToken = token, maxHeight = 720, startPositionSeconds = fromSecond });
        created.EnsureSuccessStatusCode();
        var session = await created.Content.ReadFromJsonAsync<JsonElement>();
        var createMs = clock.Elapsed.TotalMilliseconds - start;

        using var raw = new HttpClient { BaseAddress = new Uri(fixture.BaseUrl) };
        var basePath = session.GetProperty("playlistUrl").GetString()![..^"/master.m3u8".Length];
        await raw.GetStringAsync($"{basePath}/master.m3u8");
        await raw.GetStringAsync($"{basePath}/main.m3u8");
        var init = await raw.GetByteArrayAsync($"{basePath}/init.mp4");
        var initMs = clock.Elapsed.TotalMilliseconds - start;
        var first = fromSecond / (int)session.GetProperty("segmentLengthSeconds").GetDouble();
        var segment = await raw.GetByteArrayAsync($"{basePath}/{first}.m4s");
        var media = clock.Elapsed.TotalMilliseconds - start;
        Assert.NotEmpty(init);
        Assert.NotEmpty(segment);

        var sessions = await admin.GetFromJsonAsync<JsonElement>("/api/v1/transcoding/sessions");
        var live = sessions.EnumerateArray().First(s => s.GetProperty("handle").GetString() == session.GetProperty("handle").GetString());
        var startup = live.TryGetProperty("startup", out var s) ? s.GetRawText() : "n/a";
        var afterMedia = fixture.BodiesServed(copy);
        await raw.DeleteAsync(basePath);
        await client.PostAsync($"/api/v1/sessions/{token}/close", null);
        return new Measurement(resolveMs, media,
            $"create {createMs:0} ms, init {initMs:0} ms, first segment {media:0} ms, articles resolve {afterResolve} + playback {afterMedia - afterResolve}, server {startup}");
    }
}
