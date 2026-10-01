using System.Diagnostics;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Playback;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class AudioRenditionTests
{
    private static readonly ClientProfile Browser = ClientProfile.Default;

    private static readonly ClientProfile AppleTv = new()
    {
        VideoCodecs = ["h264", "hevc"],
        AudioCodecs = ["aac", "ac3", "eac3"],
        Containers = ["mp4"],
        MaxAudioChannels = 6,
        Supports10Bit = true,
    };

    private static SourceMediaInfo DualAudio(params SourceAudioStream[] audio) => Media() with
    {
        Audio = audio.Length > 0 ? audio :
        [
            new SourceAudioStream { Index = 1, Codec = "ac3", Channels = 6, Language = "ger", Title = "Deutsch AC3 5.1", SampleRate = 48_000, IsDefault = true },
            new SourceAudioStream { Index = 2, Codec = "ac3", Channels = 2, Language = "eng", Title = "English AC3 2.0", SampleRate = 48_000 },
        ],
    };

    [Fact]
    public void Remux_WithTwoRequestedTracks_PlansOneRenditionEach_SelectedIsDefault()
    {
        var plan = Decide(DualAudio(), AppleTv, ModePreference.Remux, false, new TranscodeLimits(AudioStreamIndex: 2, AudioRenditions: [2, 1]));

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.True(plan.DemuxedAudio);
        Assert.Equal([1, 2], plan.AudioRenditions.Select(r => r.Target.SourceIndex));
        Assert.Equal([2u, 3u], plan.AudioRenditions.Select(r => r.TrackId));
        Assert.Equal(["de", "en"], plan.AudioRenditions.Select(r => r.Language));
        Assert.Equal(["Deutsch AC3 5.1", "English AC3 2.0"], plan.AudioRenditions.Select(r => r.Name));
        Assert.Equal([false, true], plan.AudioRenditions.Select(r => r.IsDefault));
        Assert.All(plan.AudioRenditions, r => Assert.True(r.Target.Copy));
        Assert.Equal(2, plan.Audio!.SourceIndex);
        Assert.Equal("avc1.640028,ac-3", plan.CodecsAttribute);
    }

    [Fact]
    public void Remux_ForABrowser_ConvertsEveryRendition_ToAacStereo()
    {
        var plan = Decide(DualAudio(), Browser, ModePreference.Remux, false, new TranscodeLimits(AudioRenditions: [1, 2]));

        Assert.All(plan.AudioRenditions, r => Assert.Equal(("aac", 2, false), (r.Target.Codec, r.Target.Channels, r.Target.Copy)));
        Assert.Equal("avc1.640028,mp4a.40.2", plan.CodecsAttribute);
    }

    [Fact]
    public void Transcode_PlansAacRenditions_AndASingleTrackStaysMuxed()
    {
        var plan = Decide(DualAudio(), Browser, ModePreference.Transcode, false, new TranscodeLimits(AudioRenditions: [1, 2]));
        var single = Decide(DualAudio(), Browser, ModePreference.Transcode, false, new TranscodeLimits(AudioRenditions: [1]));

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Equal(2, plan.AudioRenditions.Count);
        Assert.All(plan.AudioRenditions, r => Assert.Equal("aac", r.Target.Codec));
        Assert.False(single.DemuxedAudio);
        Assert.False(Decide(DualAudio(), Browser, ModePreference.Transcode, false).DemuxedAudio);
    }

    [Fact]
    public void Renditions_AreCapped_AndNamesStayUnique_AndUnknownStreamsFail()
    {
        var media = DualAudio([.. Enumerable.Range(1, 6).Select(i => new SourceAudioStream { Index = i, Codec = "aac", Profile = "LC", Channels = 2, Language = "eng" })]);
        var plan = Decide(media, Browser, ModePreference.Remux, false, new TranscodeLimits(AudioRenditions: [1, 2, 3, 4, 5, 6]));

        Assert.Equal(TranscodePlanner.MaxAudioRenditions, plan.AudioRenditions.Count);
        Assert.Equal(["English", "English 2", "English 3", "English 4"], plan.AudioRenditions.Select(r => r.Name));
        var error = Assert.Throws<TranscodePlanningException>(() => Decide(media, Browser, ModePreference.Remux, false, new TranscodeLimits(AudioRenditions: [9])));
        Assert.Equal("unknown_audio_stream", error.Code);
    }

    [Fact]
    public void Master_DeclaresTheAudioGroup_AndTheVariantReferencesIt()
    {
        var plan = Decide(DualAudio(), AppleTv, ModePreference.Remux, false, new TranscodeLimits(AudioStreamIndex: 2, AudioRenditions: [1]));
        var master = HlsPlaylist.Master(plan);

        Assert.Contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Deutsch AC3 5.1\",LANGUAGE=\"de\",DEFAULT=NO,AUTOSELECT=YES,CHANNELS=\"6\",URI=\"audio/1/main.m3u8\"\n", master);
        Assert.Contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English AC3 2.0\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"audio/2/main.m3u8\"\n", master);
        Assert.Contains(",AUDIO=\"audio\"", master);
        Assert.DoesNotContain("TYPE=AUDIO", HlsPlaylist.Master(Decide(DualAudio(), AppleTv, ModePreference.Remux, false)));
    }

    [Fact]
    public void FfmpegArgs_MapEveryRendition_InTrackOrder_WithPerStreamCodecs()
    {
        var remux = Decide(DualAudio(), Browser, ModePreference.Remux, false, new TranscodeLimits(AudioRenditions: [1, 2]));
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(remux)));

        Assert.Contains("-map 0:0 -map 0:1 -map 0:2 ", args);
        Assert.Contains("-c:a:0 aac -ac:a:0 2", args);
        Assert.Contains("-c:a:1 aac -ac:a:1 2", args);
        Assert.Contains("-filter:a:0 atrim=start=", args);
        Assert.Contains("-filter:a:1 atrim=start=", args);

        var copy = Decide(DualAudio(), AppleTv, ModePreference.Transcode, false, new TranscodeLimits(AudioRenditions: [1, 2]));
        var transcode = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(copy, startSegment: 3)));
        Assert.Contains("-map 0:0 -map 0:1 -map 0:2 ", transcode);
        Assert.Contains("-c:a:0 aac -ac:a:0 2", transcode);
        Assert.Contains("-c:a:1 aac -ac:a:1 2", transcode);
        Assert.DoesNotContain("atrim", transcode);
    }

    [Fact]
    public void Offer_SelectedFirst_ThenPreferredAndDefault_OneTrackPerLanguage()
    {
        SourceAudioStream A(int index, string? language, bool isDefault = false) => new() { Index = index, Codec = "ac3", Language = language, IsDefault = isDefault };
        var media = DualAudio(A(1, "eng", true), A(2, "eng"), A(3, "ger"), A(4, "fre"), A(5, "jpn"), A(6, "spa"));
        var preferences = PlaybackPreferences.Default with { AudioLanguage = "ja" };

        Assert.Equal([3, 5, 1, 4], TrackSelector.OfferedAudio(media, media.Audio[2], preferences));
        Assert.Equal([2, 3, 4, 5], TrackSelector.OfferedAudio(media, media.Audio[1], PlaybackPreferences.Default));
        Assert.Empty(TrackSelector.OfferedAudio(DualAudio(A(1, "eng")), A(1, "eng"), PlaybackPreferences.Default));
    }

    [Theory]
    [InlineData(FfmpegArgumentBuilder.RemuxMovFlags)]
    [InlineData("+frag_keyframe+empty_moov+default_base_moof+delay_moov")]
    public async Task Split_ServesEachTrackAlone_WithTheSameFragments(string movFlags)
    {
        var directory = Directory.CreateTempSubdirectory("b5-split-").FullName;
        try
        {
            var source = Path.Combine(directory, "muxed.mp4");
            await KeyframeFixture.FfmpegAsync(
                "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=6",
                "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=6",
                "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100:duration=6",
                "-map", "0", "-map", "1", "-map", "2",
                "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p",
                "-c:a:0", "aac", "-c:a:1", "ac3", "-movflags", movFlags, "-f", "mp4", source);
            var bytes = await File.ReadAllBytesAsync(source);
            var firstMoof = IndexOf(bytes, "moof"u8) - 4;
            var init = bytes[..firstMoof];
            var media = bytes[firstMoof..];
            var muxed = Fmp4.ParseSegment(media, Fmp4.ParseInit(init));

            foreach (var (track, handler) in new[] { (1u, "vide"), (2u, "soun"), (3u, "soun") })
            {
                var splitInit = Fmp4TrackSplit.Init(init, track);
                var parsed = Fmp4.ParseInit(splitInit);
                Assert.Equal(handler, Assert.Single(parsed.Tracks).Handler);
                var segment = Fmp4TrackSplit.Segment(media, track);
                var fragments = Fmp4.ParseSegment(segment, parsed).Fragments;
                Assert.All(fragments, f => Assert.Equal(track, f.TrackId));
                Assert.Equal(muxed.Fragments.Where(f => f.TrackId == track).Select(f => (f.BaseDecodeTime, f.SampleCount)),
                    fragments.Select(f => (f.BaseDecodeTime, f.SampleCount)));

                var file = Path.Combine(directory, $"track{track}.mp4");
                await File.WriteAllBytesAsync(file, [.. splitInit, .. segment]);
                var (code, log) = await DecodeAsync(file);
                Assert.True(code == 0 && log.Length == 0, $"track {track}: {log}");
            }
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public async Task Split_RefusesAbsoluteBaseDataOffsets()
    {
        var directory = Directory.CreateTempSubdirectory("b5-split-").FullName;
        try
        {
            var source = Path.Combine(directory, "absolute.mp4");
            await KeyframeFixture.FfmpegAsync(
                "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", source);
            var bytes = await File.ReadAllBytesAsync(source);
            Assert.Throws<InvalidDataException>(() => Fmp4TrackSplit.Segment(bytes[(IndexOf(bytes, "moof"u8) - 4)..], 2));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    private static int IndexOf(byte[] data, ReadOnlySpan<byte> type) => data.AsSpan().IndexOf(type);

    private static async Task<(int Code, string Log)> DecodeAsync(string file)
    {
        using var process = Process.Start(new ProcessStartInfo("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"])
        {
            RedirectStandardError = true,
            UseShellExecute = false,
        })!;
        var log = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (process.ExitCode, log.Trim());
    }
}
