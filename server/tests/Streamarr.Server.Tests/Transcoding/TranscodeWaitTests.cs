using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>An ffmpeg whose session runs never write a segment (the probe and capability calls use the real one).</summary>
public sealed class StalledTranscodeFixture : TranscodingServerFixture
{
    public const int WaitSeconds = 5;

    protected override int SourceDurationSeconds => 20;
    protected override string SourceSize => "320x180";
    protected override int SegmentWaitTimeoutSeconds => WaitSeconds;

    protected override IReadOnlyDictionary<string, string?> ExtraSettings(string directory)
    {
        var script = Path.Combine(directory, "ffmpeg-stalled.sh");
        File.WriteAllText(script, $"#!/bin/sh\ncase \" $* \" in *\" -progress \"*) exec sleep 120;; esac\nexec ffmpeg \"$@\"\n");
        File.SetUnixFileMode(script, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return new Dictionary<string, string?> { ["Streamarr:Transcoding:FfmpegPath"] = script };
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
            var clock = Stopwatch.StartNew();
            var response = await raw.GetAsync($"{playlist[..playlist.LastIndexOf('/')]}/{file}");
            clock.Stop();

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
}
