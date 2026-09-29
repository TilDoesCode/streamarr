using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class FfmpegArgumentBuilderTests
{
    [Fact]
    public void SoftwareRun_ProducesSeekableFragmentedMp4Hls()
    {
        var plan = Plan(limits: new TranscodeLimits(MaxHeight: 720));
        var args = FfmpegArgumentBuilder.Build(Spec(plan));

        AssertSequence(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
        AssertSequence(args, "-profile:v", "high", "-level:v", "4.1");
        AssertSequence(args, "-force_key_frames:v", "expr:gte(t,n_forced*4)");
        AssertSequence(args, "-vf", "scale=w=1280:h=720,format=yuv420p");
        AssertSequence(args, "-c:a", "aac", "-ac", "2", "-b:a", "192k");
        AssertSequence(args, "-copyts", "-start_at_zero", "-avoid_negative_ts", "make_non_negative");
        AssertSequence(args, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init-1.mp4", "-start_number", "0");
        AssertSequence(args, "-hls_flags", "temp_file", "-hls_segment_options", "movflags=+frag_discont");
        AssertSequence(args, "-map", "0:0", "-map", "0:1");
        Assert.DoesNotContain("-ss", args);
        Assert.DoesNotContain("-reconnect", args);
        Assert.DoesNotContain("-hwaccel", args);
        Assert.Equal(Path.Combine("/work/session", "job-1.m3u8"), args[^1]);
    }

    [Fact]
    public void RestartAtASegment_SeeksTheInputAndNumbersSegmentsFromThere()
    {
        var args = FfmpegArgumentBuilder.Build(Spec(Plan(), startSegment: 10));

        AssertSequence(args, "-ss", "40");
        AssertSequence(args, "-start_number", "10");
        Assert.True(args.ToList().IndexOf("-ss") < args.ToList().IndexOf("-i"), "-ss must be an input option for fast seeking");
        AssertSequence(args, "-force_key_frames:v", "expr:gte(t,n_forced*4)");
    }

    [Fact]
    public void OldFfmpeg_UsesAbsoluteKeyframeTimes_AfterASeek()
    {
        var capabilities = Capabilities() with { RelativeKeyframeExpressions = false };
        var args = FfmpegArgumentBuilder.Build(Spec(Plan(), capabilities: capabilities, startSegment: 10));

        AssertSequence(args, "-force_key_frames:v", "expr:gte(t,40+n_forced*4)");
    }

    [Fact]
    public void NetworkSource_ReconnectsAndIdentifiesItself()
    {
        var args = FfmpegArgumentBuilder.Build(Spec(Plan(), network: true));

        AssertSequence(args, "-user_agent", FfmpegArgumentBuilder.UserAgent);
        AssertSequence(args, "-reconnect", "1", "-reconnect_on_network_error", "1");
        AssertSequence(args, "-i", "http://127.0.0.1:8080/api/v1/stream/abc123");
    }

    [Fact]
    public void VideoToolbox_DecodesScalesTonemapsAndEncodesOnTheGpu()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.VideoToolbox };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.Hevc10]));
        var plan = Plan(Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10), settings, capabilities,
            limits: new TranscodeLimits(MaxHeight: 1080));

        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        AssertSequence(args, "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld");
        AssertSequence(args, "-vf", "scale_vt=w=1920:h=1080:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709");
        AssertSequence(args, "-c:v", "h264_videotoolbox", "-prio_speed", "1");
        AssertSequence(args, "-g:v", "96");
        Assert.DoesNotContain("-init_hw_device", args);
    }

    [Fact]
    public void VideoToolboxDecode_WithSoftwareEncode_DownloadsTenBitSurfacesCorrectly()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.VideoToolbox, HardwareEncoding = false };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.Hevc10]));
        var plan = Plan(Media(codec: "hevc", bitDepth: 10), settings, capabilities, limits: new TranscodeLimits(MaxHeight: 720));

        Assert.Equal("scale_vt=w=1280:h=720,hwdownload,format=p010le,format=yuv420p", FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Fact]
    public void Vaapi_InitialisesTheDrmNodeAndStaysOnTheGpu()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi, VaapiDevice = "/dev/dri/renderD129" };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Vaapi, decode: [DecodeCodecs.H264]));
        var plan = Plan(settings: settings, capabilities: capabilities, limits: new TranscodeLimits(MaxHeight: 720));

        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        AssertSequence(args, "-init_hw_device", "vaapi=va:/dev/dri/renderD129", "-filter_hw_device", "va");
        AssertSequence(args, "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi");
        AssertSequence(args, "-vf", "scale_vaapi=w=1280:h=720:format=nv12");
        AssertSequence(args, "-c:v", "h264_vaapi", "-rc_mode", "VBR");
    }

    [Fact]
    public void Vaapi_WithCpuDeinterlacing_UploadsFramesForTheHardwareEncoder()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Vaapi, decode: [DecodeCodecs.Mpeg2]));
        var plan = Plan(Media(codec: "mpeg2video", width: 720, height: 576, interlaced: true, fps: 25), settings, capabilities);

        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        Assert.Equal("bwdif=mode=send_frame:parity=auto:deint=all,format=nv12,hwupload", FfmpegArgumentBuilder.BuildVideoFilters(plan));
        AssertSequence(args, "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va");
        Assert.DoesNotContain("-hwaccel", args);
    }

    [Fact]
    public void Vaapi_HardwareToneMapping_ConvertsToSdrOnTheGpu()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Vaapi, decode: [DecodeCodecs.Hevc10]));
        var plan = Plan(Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10), settings, capabilities,
            limits: new TranscodeLimits(MaxHeight: 1080));

        Assert.Equal(ToneMapMode.Hardware, plan.ToneMap);
        Assert.Equal("scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709",
            FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Fact]
    public void Qsv_DecodesThroughVaapiAndMapsSurfacesToTheQsvEncoder()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Qsv };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Qsv, decode: [DecodeCodecs.H264]));
        var plan = Plan(settings: settings, capabilities: capabilities, limits: new TranscodeLimits(MaxHeight: 720));

        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        AssertSequence(args, "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs");
        AssertSequence(args, "-vf", "scale_vaapi=w=1280:h=720:format=nv12,hwmap=derive_device=qsv,format=qsv");
        AssertSequence(args, "-c:v", "h264_qsv", "-preset", "veryfast");
        AssertSequence(args, "-look_ahead", "0", "-async_depth", "1");
    }

    [Fact]
    public void Nvenc_UsesCudaScalingAndTheFastestPresetForVeryfast()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Nvenc };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Nvenc, decode: [DecodeCodecs.H264]));
        var plan = Plan(settings: settings, capabilities: capabilities, limits: new TranscodeLimits(MaxHeight: 720));

        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        AssertSequence(args, "-init_hw_device", "cuda=cu:0", "-filter_hw_device", "cu");
        AssertSequence(args, "-hwaccel", "cuda", "-hwaccel_device", "cu", "-hwaccel_output_format", "cuda");
        AssertSequence(args, "-vf", "scale_cuda=w=1280:h=720:format=yuv420p");
        AssertSequence(args, "-c:v", "h264_nvenc", "-preset", "p1");
    }

    [Fact]
    public void Nvenc_DecodeWithSoftwareEncode_DownloadsOnce()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Nvenc, HardwareEncoding = false };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.Nvenc, decode: [DecodeCodecs.H264]));
        var plan = Plan(settings: settings, capabilities: capabilities, limits: new TranscodeLimits(MaxHeight: 720));

        Assert.Equal("scale_cuda=w=1280:h=720:format=yuv420p,hwdownload,format=yuv420p", FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Fact]
    public void SoftwareToneMapping_AppendsTheZscaleChain()
    {
        var plan = Plan(Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10), limits: new TranscodeLimits(MaxHeight: 1080));

        Assert.Equal(ToneMapMode.Software, plan.ToneMap);
        Assert.Equal(FfmpegArgumentBuilder.SoftwareToneMapChain, FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Fact]
    public void BurnIn_OverlaysTheImageSubtitle_InOneCpuGraph_BeforeScaling()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.VideoToolbox };
        var capabilities = Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.Hevc10]));
        var media = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, subtitles: [Subtitle(2, "hdmv_pgs_subtitle", "ger"), Subtitle(3, "subrip")]);
        var plan = Plan(media, settings, capabilities, limits: new TranscodeLimits(MaxHeight: 720, SubtitleStreamIndex: 2, BurnInSubtitle: true));
        var args = FfmpegArgumentBuilder.Build(Spec(plan, settings, capabilities));

        Assert.Equal(2, plan.BurnIn!.Index);
        Assert.Equal((false, true), (plan.HardwareDecode, plan.HardwareEncode));
        AssertSequence(args, "-filter_complex",
            $"[0:0]{FfmpegArgumentBuilder.SoftwareToneMapChain}[base];[base][0:2]overlay=eof_action=pass:repeatlast=0[burned];[burned]scale=w=1280:h=720,format=nv12[vout]",
            "-map", "[vout]", "-map", "0:1");
        Assert.DoesNotContain("-vf", args);
        Assert.DoesNotContain("-hwaccel", args);
    }

    [Fact]
    public void BurnIn_OfATextSubtitle_IsNotPossible_AndNotRequestedMeansNoOverlay()
    {
        var media = Media(subtitles: [Subtitle(2, "subrip"), Subtitle(3, "dvd_subtitle")]);

        var text = Plan(media, limits: new TranscodeLimits(SubtitleStreamIndex: 2, BurnInSubtitle: true));
        var notRequested = Plan(media, limits: new TranscodeLimits(SubtitleStreamIndex: 3));

        Assert.Null(text.BurnIn);
        Assert.Null(notRequested.BurnIn);
        AssertSequence(FfmpegArgumentBuilder.Build(Spec(notRequested)), "-map", "0:0", "-map", "0:1");
        Assert.DoesNotContain("-filter_complex", FfmpegArgumentBuilder.Build(Spec(text)));
    }

    [Fact]
    public void AacSource_IsCopiedInsteadOfReencoded()
    {
        var plan = Plan(Media(audioCodec: "aac", channels: 2));
        var args = FfmpegArgumentBuilder.Build(Spec(plan));

        AssertSequence(args, "-c:a", "copy");
    }

    [Fact]
    public void CopiedAudio_OfARestartedRun_DropsPacketsBeforeTheRestartPoint_OnFfmpeg6AndLater()
    {
        var plan = Plan(Media(audioCodec: "aac", channels: 2));

        var restart = FfmpegArgumentBuilder.Build(Spec(plan, startSegment: 2));
        var fromZero = FfmpegArgumentBuilder.Build(Spec(plan));
        var ffmpeg5 = FfmpegArgumentBuilder.Build(Spec(plan, capabilities: Capabilities() with { MajorVersion = 5 }, startSegment: 2));
        var converted = FfmpegArgumentBuilder.Build(Spec(Plan(Media(audioCodec: "eac3", channels: 6)), startSegment: 2));

        AssertSequence(restart, "-c:a", "copy", "-bsf:a", "noise=drop=lt(pts*tb\\,8)");
        Assert.DoesNotContain("-bsf:a", fromZero);
        Assert.DoesNotContain("-bsf:a", ffmpeg5);
        Assert.DoesNotContain("-bsf:a", converted);
    }

    [Fact]
    public void ThreadLimit_AndInputDuration_AreApplied()
    {
        var args = FfmpegArgumentBuilder.Build(Spec(Plan(), new TranscodingSettings { Threads = 3 }) with { MaxInputSeconds = 12.5 });

        AssertSequence(args, "-t", "12.5");
        AssertSequence(args, "-threads", "3");
        Assert.True(args.ToList().IndexOf("-threads") > args.ToList().IndexOf("-i"), "-threads must limit the encoder, not only the decoder");
    }

    [Theory]
    [InlineData(4, 24000d / 1001, 96)]
    [InlineData(4, 24, 96)]
    [InlineData(4, 25, 100)]
    [InlineData(6, 30000d / 1001, 180)]
    [InlineData(2, 60, 120)]
    public void GopFrames_CoverExactlyOneSegment(double length, double fps, int frames)
        => Assert.Equal(frames, FfmpegArgumentBuilder.GopFrames(length, fps));

    private static readonly ClientProfile HdrClient = new()
    {
        VideoCodecs = ["h264", "hevc"], AudioCodecs = ["aac", "ac3", "eac3"], Containers = ["mp4"], MaxAudioChannels = 6,
        Supports10Bit = true, HdrFormats = ["hdr10"],
    };

    [Fact]
    public void Remux_CopiesVideoIntoFragmentedMp4OnStdout_PlusOneWebVttFilePerTextSubtitle()
    {
        var media = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, audioCodec: "truehd",
            subtitles: [Subtitle(2, "subrip"), Subtitle(3, "hdmv_pgs_subtitle"), Subtitle(4, "ass", "ger")]);
        var plan = Decide(media, HdrClient, allowDirect: false);

        var args = FfmpegArgumentBuilder.Build(Spec(plan, network: true));

        AssertSequence(args, "-map", "0:0", "-map", "0:1", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-c:v", "copy", "-tag:v", "hvc1");
        AssertSequence(args, "-c:a", "eac3", "-ac", "6", "-b:a", "640k", "-af", "atrim=start=0.009");
        AssertSequence(args, "-copyts", "-start_at_zero", "-avoid_negative_ts", "disabled");
        AssertSequence(args, "-f", "mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont+skip_trailer", "pipe:1");
        AssertSequence(args, "-map", "0:2", "-c:s", "webvtt", "-avoid_negative_ts", "disabled", "-flush_packets", "1", "-f", "webvtt", "-y",
            Path.Combine("/work/session", "sub-2-1.vtt"));
        Assert.Equal(Path.Combine("/work/session", "sub-4-1.vtt"), args[^1]);
        Assert.DoesNotContain("0:3", args);
        Assert.DoesNotContain("-progress", args);
        Assert.DoesNotContain("-ss", args);
        Assert.DoesNotContain("-hls_time", args);
        AssertSequence(args, "-reconnect", "1");
    }

    [Fact]
    public void RemuxRestart_SeeksInMicroseconds_CopiesAudio_AndDoesNotTrim()
    {
        var plan = Decide(Media(codec: "h264", audioCodec: "ac3", channels: 6), HdrClient, allowDirect: false);

        var args = FfmpegArgumentBuilder.Build(Spec(plan, startSegment: 8) with { SeekSeconds = 48.150435 });

        AssertSequence(args, "-ss", "48.150435", "-i", "/samples/movie.mkv");
        AssertSequence(args, "-c:v", "copy", "-c:a", "copy", "-copyts");
        Assert.DoesNotContain("-tag:v", args);
        Assert.DoesNotContain("-af", args);
    }

    [Fact]
    public void RemuxRestart_WithConvertedAudio_StartsOnTheFrameGridOfTheRunFromZero()
    {
        var plan = Decide(Media(codec: "h264", audioCodec: "eac3", channels: 6), ClientProfile.Default, allowDirect: false);

        var args = FfmpegArgumentBuilder.Build(Spec(plan, startSegment: 2) with { SeekSeconds = 8.155435, SourceAudioSampleRate = 48_000 });

        AssertSequence(args, "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-af", "atrim=start=8.171667");
    }

    [Theory]
    [InlineData(null, "aac", 48_000, 0, 0.065)]
    [InlineData(8.155435, "aac", 48_000, 0, 0.065 + 380 * 1024d / 48_000)]
    [InlineData(8.155435, "ac3", 48_000, 0, 0.009 + 255 * 1536d / 48_000)]
    [InlineData(8.155435, "aac", 44_100, 0.5, 0.5 + 330 * 1024d / 44_100)]
    [InlineData(0.3, "aac", 48_000, 0.5, 0.5)]
    public void RemuxAudioTrim_PrimingForTheFirstRun_ElseTheNextFrameBoundaryOfThatRun(double? seek, string codec, int rate, double audioStart, double expected)
    {
        var audio = new AudioTarget(1, "eac3", false, 2, 192, null, codec, codec == "aac" ? "mp4a.40.2" : "ac-3");

        var trim = FfmpegArgumentBuilder.RemuxAudioTrimSeconds(seek, audio, rate, audioStart);

        Assert.Equal(expected, trim, 0.0000001);
        Assert.True(seek is null || trim >= seek);
    }

    [Theory]
    [InlineData(6.005, 8.005, 6.155435)]
    [InlineData(10, 10.1, 10.05)]
    [InlineData(10, null, 10.150435)]
    [InlineData(4, 4.2, 4.150435)]
    public void RemuxSeekSeconds_LandsOnTheKeyframeWithAndWithoutFfmpegsDtsHeuristic(double keyframe, double? next, double expected)
    {
        var seek = FfmpegArgumentBuilder.RemuxSeekSeconds(keyframe, next);

        Assert.Equal(expected, seek, 0.000001);
        Assert.InRange(seek, keyframe, next ?? double.MaxValue);
    }

    private static void AssertSequence(IReadOnlyList<string> args, params string[] expected)
    {
        for (var i = 0; i + expected.Length <= args.Count; i++)
        {
            if (args.Skip(i).Take(expected.Length).SequenceEqual(expected))
                return;
        }
        Assert.Fail($"Expected the sequence [{string.Join(' ', expected)}] in:\n{string.Join(' ', args)}");
    }
}
