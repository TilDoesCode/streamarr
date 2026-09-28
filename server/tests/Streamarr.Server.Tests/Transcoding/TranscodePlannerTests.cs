using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class TranscodePlannerTests
{
    private static readonly TranscodingSettings VideoToolbox = new() { Acceleration = HardwareAcceleration.VideoToolbox };

    [Fact]
    public void TypicalWebDl_NeedsTheServer_AndBecomesBrowserSafeH264Aac()
    {
        var plan = Plan();

        Assert.False(plan.DirectPlayPossible);
        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("'mkv'"));
        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("'ac3'"));
        Assert.Equal(("h264", 1920, 1080), (plan.Video.Codec, plan.Video.Width, plan.Video.Height));
        Assert.Equal("libx264", plan.Encoder);
        Assert.Equal("4.1", plan.Video.Level);
        Assert.Equal("avc1.640029,mp4a.40.2", plan.CodecsAttribute);
        Assert.NotNull(plan.Audio);
        Assert.False(plan.Audio.Copy);
        Assert.Equal(2, plan.Audio.Channels);
        Assert.Equal(192, plan.Audio.BitrateKbps);
        Assert.False(plan.HardwareDecode);
        Assert.False(plan.HardwareEncode);
    }

    [Fact]
    public void BrowserCompatibleMp4_IsDirectPlayable_AndItsAacIsCopied()
    {
        var plan = Plan(Media(width: 1280, height: 720, container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2, bitRate: 3_000_000));

        Assert.True(plan.DirectPlayPossible, string.Join("; ", plan.DirectPlayBlockers));
        Assert.True(plan.Audio!.Copy);
        Assert.False(plan.Scales);
    }

    [Fact]
    public void HdrUhd_OnVideoToolbox_UsesHardwareDecodeEncodeAndToneMapping()
    {
        var plan = Plan(
            Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, bitRate: 20_000_000),
            VideoToolbox,
            Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.Hevc10, DecodeCodecs.H264])),
            limits: new TranscodeLimits(MaxHeight: 1080));

        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("10-bit"));
        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("HDR"));
        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("2160p exceeds the 1080p limit"));
        Assert.Equal((1920, 1080), (plan.Video.Width, plan.Video.Height));
        Assert.True(plan.HardwareDecode, plan.HardwareDecodeReason);
        Assert.True(plan.HardwareEncode, plan.HardwareEncodeReason);
        Assert.Equal("h264_videotoolbox", plan.Encoder);
        Assert.Equal(ToneMapMode.Hardware, plan.ToneMap);
    }

    [Fact]
    public void UnvalidatedDecoder_FallsBackToCpuDecode_WithAnExplanation()
    {
        var plan = Plan(
            Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10),
            VideoToolbox,
            Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.H264])));

        Assert.False(plan.HardwareDecode);
        Assert.Contains("did not validate", plan.HardwareDecodeReason);
        Assert.Contains("hevc10", plan.HardwareDecodeReason);
        Assert.True(plan.HardwareEncode);
        Assert.Equal(ToneMapMode.Software, plan.ToneMap);
    }

    [Fact]
    public void ManualDecodeList_OverridesTheSelfTest()
    {
        var plan = Plan(
            Media(codec: "hevc"),
            VideoToolbox with { HardwareDecodingCodecs = [DecodeCodecs.H264] },
            Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.H264, DecodeCodecs.Hevc])));

        Assert.False(plan.HardwareDecode);
        Assert.Contains("not enabled in the settings", plan.HardwareDecodeReason);
    }

    [Fact]
    public void TenBitH264_NeverUsesHardwareDecode()
    {
        var plan = Plan(
            Media(bitDepth: 10),
            VideoToolbox,
            Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [.. DecodeCodecs.All])));

        Assert.False(plan.HardwareDecode);
        Assert.Contains("No hardware decoder path", plan.HardwareDecodeReason);
    }

    [Fact]
    public void AcceleratorMissingFromTheBuild_DegradesToSoftwareWithAWarning()
    {
        var plan = Plan(settings: new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi }, capabilities: Capabilities());

        Assert.Equal(HardwareAcceleration.None, plan.Acceleration);
        Assert.Equal("libx264", plan.Encoder);
        Assert.Contains(plan.Warnings, w => w.Contains("VA-API"));
    }

    [Fact]
    public void FailedEncoderSelfTest_FallsBackToSoftwareEncode()
    {
        var plan = Plan(
            settings: new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi },
            capabilities: Capabilities(Accelerator(HardwareAcceleration.Vaapi, h264Encode: false, decode: [DecodeCodecs.H264])));

        Assert.True(plan.HardwareDecode);
        Assert.False(plan.HardwareEncode);
        Assert.Equal("libx264", plan.Encoder);
        Assert.Contains("self-test failed", plan.HardwareEncodeReason);
        Assert.Contains(plan.Warnings, w => w.Contains("h264_vaapi"));
    }

    [Fact]
    public void HardwareEncodingDisabled_KeepsHardwareDecode()
    {
        var plan = Plan(
            settings: new TranscodingSettings { Acceleration = HardwareAcceleration.Nvenc, HardwareEncoding = false },
            capabilities: Capabilities(Accelerator(HardwareAcceleration.Nvenc, decode: [DecodeCodecs.H264])));

        Assert.True(plan.HardwareDecode);
        Assert.False(plan.HardwareEncode);
        Assert.Equal("libx264", plan.Encoder);
    }

    [Fact]
    public void InterlacedSource_IsDeinterlacedOnTheCpu()
    {
        var plan = Plan(
            Media(codec: "mpeg2video", width: 720, height: 576, interlaced: true, fps: 25),
            VideoToolbox,
            Capabilities(Accelerator(HardwareAcceleration.VideoToolbox, decode: [DecodeCodecs.Mpeg2])));

        Assert.True(plan.Deinterlace);
        Assert.False(plan.HardwareDecode);
        Assert.Contains("Interlaced", plan.HardwareDecodeReason);
        Assert.Contains(plan.DirectPlayBlockers, b => b.Contains("Interlaced"));
    }

    [Theory]
    [InlineData(false, true, ToneMapMode.Disabled)]
    [InlineData(true, false, ToneMapMode.Unavailable)]
    [InlineData(true, true, ToneMapMode.Software)]
    public void SoftwareToneMapping_DependsOnSettingAndFilters(bool enabled, bool filtersAvailable, ToneMapMode expected)
    {
        var capabilities = Capabilities() with
        {
            Filters = filtersAvailable ? new HashSet<string> { "zscale", "tonemap" } : new HashSet<string> { "scale" },
        };

        var plan = Plan(Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10), new TranscodingSettings { ToneMapping = enabled }, capabilities);

        Assert.Equal(expected, plan.ToneMap);
        if (expected != ToneMapMode.Software)
            Assert.Contains(plan.Warnings, w => w.Contains("washed out"));
    }

    [Fact]
    public void HevcOutput_RequiresBothTheSettingAndAClientThatDecodesIt()
    {
        var hevcClient = ClientProfile.Default with { VideoCodecs = ["h264", "hevc"] };

        var allowed = Plan(settings: new TranscodingSettings { AllowHevcOutput = true }, client: hevcClient);
        var notAllowed = Plan(client: hevcClient);
        var noX265 = Plan(
            settings: new TranscodingSettings { AllowHevcOutput = true },
            client: hevcClient,
            capabilities: Capabilities() with { Encoders = new HashSet<string> { "libx264", "aac" } });

        Assert.Equal(("hevc", "libx265", "hvc1.1.6.L120.B0"), (allowed.Video.Codec, allowed.Encoder, allowed.Video.CodecsTag));
        Assert.Equal("h264", notAllowed.Video.Codec);
        Assert.Equal(("h264", "libx264"), (noX265.Video.Codec, noX265.Encoder));
    }

    [Fact]
    public void SurroundAudio_IsKeptOnlyWhenAllowedAndSupported()
    {
        var surroundClient = ClientProfile.Default with { MaxAudioChannels = 6 };

        var surround = Plan(settings: new TranscodingSettings { AllowSurroundAudio = true }, client: surroundClient);
        var stereoClient = Plan(settings: new TranscodingSettings { AllowSurroundAudio = true });

        Assert.Equal((6, 576), (surround.Audio!.Channels, surround.Audio.BitrateKbps));
        Assert.Equal(2, stereoClient.Audio!.Channels);
    }

    [Fact]
    public void AudioSelection_PrefersTheDefaultTrack_AndValidatesExplicitIndexes()
    {
        var media = Media() with
        {
            Audio =
            [
                new SourceAudioStream { Index = 1, Codec = "ac3", Channels = 6, Language = "ger" },
                new SourceAudioStream { Index = 2, Codec = "eac3", Channels = 6, Language = "eng", IsDefault = true },
            ],
        };

        Assert.Equal(2, TranscodePlanner.SelectAudio(media, null)!.Index);
        Assert.Equal(1, TranscodePlanner.SelectAudio(media, 1)!.Index);
        var error = Assert.Throws<TranscodePlanningException>(() => TranscodePlanner.SelectAudio(media, 7));
        Assert.Equal("unknown_audio_stream", error.Code);
    }

    [Fact]
    public void UnplannableSources_AreRejectedWithSpecificCodes()
    {
        Assert.Equal("no_video_stream", Assert.Throws<TranscodePlanningException>(() => Plan(Media() with { Video = null })).Code);
        Assert.Equal("unknown_duration", Assert.Throws<TranscodePlanningException>(() => Plan(Media(duration: 0))).Code);
        Assert.Equal("unknown_dimensions", Assert.Throws<TranscodePlanningException>(() => Plan(Media(width: 0))).Code);
    }

    [Theory]
    [InlineData(1920, 1080, 1080, 1920, 1080)]
    [InlineData(1920, 800, 1080, 1920, 800)]
    [InlineData(3840, 1600, 720, 1280, 534)]
    [InlineData(1080, 1920, 1080, 608, 1080)]
    [InlineData(721, 481, 2160, 720, 480)]
    [InlineData(3840, 2160, 480, 854, 480)]
    public void FitWithin_KeepsAspectAndEvenDimensions(int w, int h, int maxHeight, int expectedW, int expectedH)
        => Assert.Equal((expectedW, expectedH), TranscodePlanner.FitWithin(w, h, maxHeight));

    [Fact]
    public void TargetBitrate_FollowsTheSourceDownward_ButNeverBelowTheFloor()
    {
        var media = Media(bitRate: 6_000_000);
        var hevc = Media(codec: "hevc", bitRate: 6_000_000);

        var downscaled = TranscodePlanner.TargetBitrate(media, media.Video!, 1280, 720, 20_000, "h264");
        var fromHevc = TranscodePlanner.TargetBitrate(hevc, hevc.Video!, 1920, 1080, 20_000, "h264");
        var capped = TranscodePlanner.TargetBitrate(media, media.Video!, 1920, 1080, 3_000, "h264");
        var tiny = TranscodePlanner.TargetBitrate(Media(bitRate: 100_000), media.Video!, 320, 180, 20_000, "h264");

        Assert.InRange(downscaled, 3_500, 4_500);
        Assert.True(fromHevc > 6_000, "HEVC sources need more H.264 bits for the same quality");
        Assert.Equal(3_000, capped);
        Assert.Equal(400, tiny);
    }

    [Fact]
    public void AudioBitrate_IsTakenFromTheVideoBudget()
    {
        var plan = Plan(Media(bitRate: 50_000_000), new TranscodingSettings { MaxBitrateKbps = 5_000 });

        Assert.Equal(5_000 - 192, plan.Video.BitrateKbps);
        Assert.Equal(5_000 * 1000, plan.BandwidthBitsPerSecond);
    }

    [Theory]
    [InlineData(1280, 720, 30, "4.1")]
    [InlineData(1920, 1080, 23.976, "4.1")]
    [InlineData(1920, 1080, 60, "4.2")]
    [InlineData(3840, 2160, 24, "5.1")]
    [InlineData(3840, 2160, 60, "5.2")]
    public void H264Level_MatchesTheSpecLimits(int w, int h, double fps, string level)
        => Assert.Equal(level, TranscodePlanner.H264Level(w, h, fps));

    [Theory]
    [InlineData("4.1", "avc1.640029")]
    [InlineData("5.1", "avc1.640033")]
    public void H264CodecsTag_IsRfc6381HighProfile(string level, string tag)
        => Assert.Equal(tag, TranscodePlanner.H264CodecsTag(level));

    [Theory]
    [InlineData("matroska,webm", "mkv")]
    [InlineData("mov,mp4,m4a,3gp,3g2,mj2", "mp4")]
    [InlineData("mpegts", "ts")]
    [InlineData("avi", "avi")]
    [InlineData(null, "unknown")]
    public void ContainerFamily_NormalizesFfprobeFormatNames(string? format, string family)
        => Assert.Equal(family, TranscodePlanner.ContainerFamily(format));
}
