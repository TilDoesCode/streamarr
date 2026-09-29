using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>Feeds the real remux argv's stdout through <see cref="RemuxSegmenter"/>, like a session does.</summary>
public sealed class RemuxSegmenterTests(KeyframeFixture fixture) : IClassFixture<KeyframeFixture>
{
    private sealed record Run(SourceMediaInfo Media, TranscodePlan Plan, SegmentTimeline Timeline, string Directory, List<(int Start, int Segment)> Written);

    private async Task<Run> RemuxAsync(int startSegment, bool clean = true, Func<byte[], Fmp4Init>? adopt = null)
    {
        var json = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", fixture.Mkv);
        var media = SourceMediaProber.Parse(json);
        await using var range = new FileRangeSource(fixture.Mkv);
        var container = await MatroskaIndexReader.ReadAsync(range, CancellationToken.None);
        var index = new KeyframeIndex(container!, container!.Config, 0);
        var plan = TranscodePlanner.FinalizeRemux(Decide(media, ClientProfile.Default, allowDirect: false), media, index, container.TotalBytes);
        var timeline = plan.RemuxTimeline!;
        var directory = Directory.CreateTempSubdirectory("streamarr-segmenter-").FullName;
        var keyframes = index.Keyframes.Select(k => k - media.StartTime).ToList();
        var previous = keyframes.LastOrDefault(k => k < timeline.StartOf(startSegment) - 1e-6, double.NaN);
        var spec = new FfmpegJobSpec
        {
            Plan = plan,
            Source = new TranscodeSource(TranscodeSource.SampleKind, fixture.Mkv, false, "fixture"),
            Settings = new TranscodingSettings(),
            Capabilities = Capabilities(),
            OutputDirectory = directory,
            JobTag = "1",
            SegmentLength = timeline.SegmentLength,
            StartSegment = startSegment,
            SeekSeconds = startSegment > 0 && !double.IsNaN(previous) ? FfmpegArgumentBuilder.RemuxSeekSeconds(previous, timeline.StartOf(startSegment)) : null,
        };

        var psi = new ProcessStartInfo("ffmpeg") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in FfmpegArgumentBuilder.Build(spec))
            psi.ArgumentList.Add(argument);
        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var written = new List<(int, int)>();
        var segmenter = new RemuxSegmenter(
            directory, spec.InitFileName, timeline, startSegment, 0.05,
            adopt ?? (init => Fmp4.ParseInit(init)),
            (start, segment) => written.Add((start, segment)),
            (_, _) => { },
            NullLogger.Instance);
        await segmenter.RunAsync(process.StandardOutput.BaseStream, async () =>
        {
            await process.WaitForExitAsync();
            return clean && process.ExitCode == 0;
        }, CancellationToken.None);
        Assert.True(process.ExitCode == 0, await stderr);
        return new Run(media, plan, timeline, directory, written);
    }

    private static List<Fmp4TrackTiming> Video(Run run, int segment)
    {
        var init = Fmp4.ParseInit(File.ReadAllBytes(Path.Combine(run.Directory, "init-1.mp4")));
        return Fmp4.ParseSegment(File.ReadAllBytes(Path.Combine(run.Directory, $"{segment}.m4s")), init).Timings(init).Where(t => t.Handler == "vide").ToList();
    }

    [Fact]
    public async Task FullRun_WritesEveryPlannedSegment_OnItsKeyframe_AndTheResultDecodesCleanly()
    {
        var run = await RemuxAsync(0);
        try
        {
            Assert.Equal([0, 9.25, 16, 22.5, 30], run.Timeline.Starts.Select(s => s == 0 ? 0 : Math.Round(s + run.Media.StartTime, 3)));
            Assert.Equal(Enumerable.Range(0, run.Timeline.Count).Select(i => (0, i)), run.Written);
            double? decodeEnd = null;
            for (var i = 0; i < run.Timeline.Count; i++)
            {
                var video = Assert.Single(Video(run, i));
                Assert.True(video.StartsWithKeyframe, $"segment {i}");
                Assert.InRange(video.StartSeconds - run.Timeline.StartOf(i), -0.001, 0.03);
                if (decodeEnd is { } end)
                    Assert.Equal(end, video.DecodeStartSeconds, 3);
                decodeEnd = video.DecodeStartSeconds + video.DurationSeconds;
            }

            var joined = Path.Combine(run.Directory, "joined.mp4");
            await using (var output = File.Create(joined))
            {
                foreach (var file in new[] { "init-1.mp4" }.Concat(Enumerable.Range(0, run.Timeline.Count).Select(i => $"{i}.m4s")))
                    await output.WriteAsync(await File.ReadAllBytesAsync(Path.Combine(run.Directory, file)));
            }
            var probe = await KeyframeFixture.RunAsync("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels:format=duration", "-of", "csv=p=0", joined);
            Assert.Contains("h264", probe);
            Assert.Contains("aac", probe);
            var decode = await KeyframeFixture.RunAsync("ffmpeg", "-v", "error", "-i", joined, "-f", "null", "-");
            Assert.Equal(string.Empty, decode.Trim());
        }
        finally
        {
            Directory.Delete(run.Directory, true);
        }
    }

    [Fact]
    public async Task Restart_BeginsAKeyframeEarly_DropsThePreRoll_AndLandsOnThePlannedStart()
    {
        var run = await RemuxAsync(3);
        try
        {
            Assert.Equal(3, run.Written.First().Segment);
            Assert.All(run.Written, w => Assert.Equal(3, w.Start));
            Assert.False(File.Exists(Path.Combine(run.Directory, "2.m4s")));
            var video = Assert.Single(Video(run, 3));
            Assert.True(video.StartsWithKeyframe);
            Assert.InRange(video.StartSeconds - run.Timeline.StartOf(3), -0.001, 0.03);
        }
        finally
        {
            Directory.Delete(run.Directory, true);
        }
    }

    [Fact]
    public async Task UncleanExit_NeverWritesTheOpenTailAsComplete()
    {
        var run = await RemuxAsync(0, clean: false);
        try
        {
            var last = run.Timeline.Count - 1;
            Assert.False(File.Exists(Path.Combine(run.Directory, $"{last}.m4s")));
            Assert.True(File.Exists(Path.Combine(run.Directory, $"{last - 1}.m4s")));
            Assert.Empty(Directory.GetFiles(run.Directory, "*.tmp"));
        }
        finally
        {
            Directory.Delete(run.Directory, true);
        }
    }

    [Fact]
    public async Task ARunWithADifferentEditDelay_IsShiftedOntoTheServedInitsTimeline()
    {
        Fmp4Init? own = null;
        var run = await RemuxAsync(0, adopt: init =>
        {
            own = Fmp4.ParseInit(init);
            return own with { Tracks = own.Tracks.Select(t => t.Handler == "vide" ? t with { EditMediaTime = t.EditMediaTime + 500 } : t).ToList() };
        });
        try
        {
            var video = own!.Video!;
            var bytes = File.ReadAllBytes(Path.Combine(run.Directory, "1.m4s"));
            var shifted = Fmp4.ParseSegment(bytes, own).Fragments.First(f => f.TrackId == video.TrackId).BaseDecodeTime;

            Fmp4.ShiftDecodeTimes(bytes, new Dictionary<uint, long> { [video.TrackId] = -500 });

            var fragment = Fmp4.ParseSegment(bytes, own).Fragments.First(f => f.TrackId == video.TrackId);
            Assert.Equal(fragment.BaseDecodeTime + 500, shifted);
            var presented = (fragment.BaseDecodeTime + fragment.FirstCompositionOffset - video.EditMediaTime) / (double)video.Timescale;
            Assert.InRange(presented - run.Timeline.StartOf(1), -0.001, 0.03);
        }
        finally
        {
            Directory.Delete(run.Directory, true);
        }
    }
}
