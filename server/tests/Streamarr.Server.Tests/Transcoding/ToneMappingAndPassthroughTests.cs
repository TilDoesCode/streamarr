using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

/// <summary>Tone-mapping chains and their settings, Dolby Vision base layers and HDMI-bitstream audio in the planner.</summary>
public sealed class ToneMappingAndPassthroughTests
{
    private static readonly SourceMediaInfo UhdHdr10 = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, colorTransfer: "smpte2084");

    private static FfmpegCapabilities Vaapi(bool procamp = true, bool? toneMapTest = true)
    {
        var accelerator = Accelerator(HardwareAcceleration.Vaapi, decode: [DecodeCodecs.Hevc10]) with { ToneMapping = new CapabilityCheck(toneMapTest) };
        var capabilities = Capabilities(accelerator);
        return procamp ? capabilities with { Filters = new HashSet<string>(capabilities.Filters) { "procamp_vaapi" } } : capabilities;
    }

    private static readonly ClientProfile RockTv = new()
    {
        VideoCodecs = ["h264", "hevc"],
        AudioCodecs = ["aac", "ac3", "eac3", "dts"],
        PassthroughAudioCodecs = ["ac3", "eac3", "dts"],
        Containers = ["mp4"],
        MaxAudioChannels = 2,
        Supports10Bit = true,
        HdrFormats = ["hdr10", "hlg"],
    };

    [Fact]
    public void Vaapi_LiftsTheVppToneMapping_WithProcampBrightness16_LikeJellyfin()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi };

        var plan = Plan(UhdHdr10, settings, Vaapi());

        Assert.Equal(ToneMapMode.Hardware, plan.ToneMap);
        Assert.Equal(
            $"scale_vaapi=w=3840:h=2160:format=p010,procamp_vaapi=b=16,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,{FfmpegArgumentBuilder.SdrTagChain}",
            FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Theory]
    [InlineData(0, 1.0, "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709")]
    [InlineData(24, 1.2, "procamp_vaapi=b=24:c=1.2,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709")]
    [InlineData(0, 1.5, "procamp_vaapi=c=1.5,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709")]
    public void VaapiToneMapChain_FollowsTheSettings(int brightness, double contrast, string expected)
    {
        var settings = new TranscodingSettings { VppToneMappingBrightness = brightness, VppToneMappingContrast = contrast };

        Assert.Equal(expected, FfmpegArgumentBuilder.VaapiToneMapChain(ToneMapOptions.From(settings, Vaapi())));
    }

    [Fact]
    public void Vaapi_WithoutProcampInTheBuild_KeepsThePlainVppChain()
    {
        var options = ToneMapOptions.From(new TranscodingSettings(), Vaapi(procamp: false));

        Assert.Equal("tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709", FfmpegArgumentBuilder.VaapiToneMapChain(options));
    }

    [Fact]
    public void Vaapi_WhoseToneMapSelfTestFailed_ToneMapsOnTheCpu()
    {
        var settings = new TranscodingSettings { Acceleration = HardwareAcceleration.Vaapi };

        var plan = Plan(UhdHdr10, settings, Vaapi(toneMapTest: false));

        Assert.Equal(ToneMapMode.Software, plan.ToneMap);
        Assert.Contains(plan.Warnings, w => w.Contains("self-test failed", StringComparison.Ordinal));
        Assert.StartsWith("scale_vaapi=w=3840:h=2160:format=p010,hwdownload,format=p010le,zscale=t=linear:npl=203,", FfmpegArgumentBuilder.BuildVideoFilters(plan));
    }

    [Fact]
    public void SoftwareToneMapping_DefaultsToMobiusWithBt2408ReferenceWhite_AndFollowsTheSettings()
    {
        var standard = Plan(UhdHdr10);
        var custom = Plan(UhdHdr10, new TranscodingSettings { ToneMappingAlgorithm = "hable", ToneMappingReferenceWhiteNits = 100 });

        Assert.Equal(
            "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
            FfmpegArgumentBuilder.SoftwareToneMapChain(standard.ToneMapOptions));
        Assert.Equal(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
            FfmpegArgumentBuilder.SoftwareToneMapChain(custom.ToneMapOptions));
        Assert.StartsWith(FfmpegArgumentBuilder.SoftwareToneMapChain(custom.ToneMapOptions), FfmpegArgumentBuilder.BuildVideoFilters(custom));
    }

    [Theory]
    [InlineData("bt2390", 203, 16, 1.0, "toneMappingAlgorithm")]
    [InlineData("mobius", 50, 16, 1.0, "toneMappingReferenceWhiteNits")]
    [InlineData("mobius", 203, 101, 1.0, "vppToneMappingBrightness")]
    [InlineData("mobius", 203, 16, 0.0, "vppToneMappingContrast")]
    public void ToneMappingSettings_AreValidated(string algorithm, int white, int brightness, double contrast, string field)
    {
        var settings = new TranscodingSettings
        {
            ToneMappingAlgorithm = algorithm, ToneMappingReferenceWhiteNits = white, VppToneMappingBrightness = brightness, VppToneMappingContrast = contrast,
        };

        Assert.Contains(settings.Validate(), e => e.Contains(field, StringComparison.Ordinal));
        Assert.Empty(new TranscodingSettings().Validate());
    }

    [Fact]
    public void ToneMappingSettings_ArePartialUpdates()
    {
        var current = new TranscodingSettings();

        var updated = TranscodingResponses.Apply(current, new TranscodingConfigWrite { ToneMappingAlgorithm = " Hable ", VppToneMappingBrightness = 0 }, out var error);

        Assert.Null(error);
        Assert.Equal(("hable", 203, 0, 1.0), (updated.ToneMappingAlgorithm, updated.ToneMappingReferenceWhiteNits, updated.VppToneMappingBrightness, updated.VppToneMappingContrast));
    }

    [Theory]
    [InlineData(8, 1, ToneMapMode.Software)]
    [InlineData(8, 4, ToneMapMode.Software)]
    [InlineData(8, 2, ToneMapMode.NotNeeded)]
    [InlineData(5, 0, ToneMapMode.Software)]
    public void DolbyVision_IsToneMappedFromItsBaseLayer_AndAnSdrBaseLayerNeedsNone(int profile, int compatibility, ToneMapMode expected)
    {
        var media = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.DolbyVision, dvProfile: profile, dvCompatibility: compatibility,
            colorTransfer: compatibility switch { 1 => "smpte2084", 4 => "arib-std-b67", 2 => "bt709", _ => null });

        var plan = Plan(media);

        Assert.Equal(expected, plan.ToneMap);
        Assert.Equal(profile == 5, plan.Warnings.Any(w => w.Contains("Dolby Vision", StringComparison.Ordinal)));
    }

    [Fact]
    public void DolbyVision_OnAnSdrScreen_SaysDolbyVisionIsConverted()
    {
        var media = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.DolbyVision, dvProfile: 8, dvCompatibility: 1, colorTransfer: "smpte2084");

        var plan = Decide(media, RockTv with { HdrFormats = [] });

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Equal("dolbyvision", plan.Reasons.Single(r => r.Code == "hdr_unsupported").Params!["hdr"]);
        Assert.Equal(HdrFormat.None, plan.DisplayedHdr);
    }

    [Theory]
    [InlineData("eac3", 6)]
    [InlineData("ac3", 6)]
    [InlineData("eac3", 8)]
    public void BitstreamAudio_IsCopiedByARemux_WhateverThePcmChannelLimit(string codec, int channels)
    {
        var plan = Decide(Media(audioCodec: codec, channels: channels), RockTv);

        Assert.Equal(DeliveryMode.Remux, plan.Mode);
        Assert.Equal((codec, true, channels), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels));
        Assert.Contains(plan.Reasons, r => r.Code == "audio_copied");
    }

    [Fact]
    public void SurroundTheSinkDecodes_IsConvertedToEac3_NotToAacStereo()
    {
        var plan = Decide(Media(audioCodec: "truehd", channels: 8), RockTv with { AudioCodecs = ["aac", "eac3"], PassthroughAudioCodecs = ["eac3"] });

        Assert.Equal(("eac3", false, 6), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels));
    }

    [Fact]
    public void Transcode_KeepsBitstreamAudio_AndAllRenditionsShareOneCodec()
    {
        var media = Media(codec: "mpeg2video", audioCodec: "eac3", channels: 6) with
        {
            Audio =
            [
                new SourceAudioStream { Index = 1, Codec = "eac3", Channels = 6, Language = "ger", SampleRate = 48_000 },
                new SourceAudioStream { Index = 2, Codec = "eac3", Channels = 6, Language = "eng", SampleRate = 48_000 },
                new SourceAudioStream { Index = 3, Codec = "aac", Channels = 2, Profile = "LC", Language = "fra", SampleRate = 48_000 },
            ],
        };

        var bitstream = Decide(media, RockTv, limits: new TranscodeLimits(AudioStreamIndex: 1, AudioRenditions: [1, 2]));
        var mixed = Decide(media, RockTv, limits: new TranscodeLimits(AudioStreamIndex: 1, AudioRenditions: [1, 2, 3]));
        var args = FfmpegArgumentBuilder.Build(Spec(Decide(media, RockTv)));

        Assert.Equal(DeliveryMode.Transcode, bitstream.Mode);
        Assert.All(bitstream.AudioRenditions, r => Assert.Equal(("eac3", true), (r.Target.Codec, r.Target.Copy)));
        Assert.All(mixed.AudioRenditions, r => Assert.Equal("eac3", r.Target.Codec));
        Assert.Equal([true, true, false], mixed.AudioRenditions.Select(r => r.Target.Copy));
        Assert.Equal(2, mixed.AudioRenditions[2].Target.Channels);
        Assert.Equal("ec-3", Decide(media, RockTv).Audio!.CodecsTag);
        Assert.Equal("copy", args[args.ToList().IndexOf("-c:a") + 1]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Transcode_KeepsSurroundTheSinkDecodes_AsEac3_WhateverTheAacSurroundSetting(bool allowSurroundAudio)
    {
        // Device check 15:30: Big Buck Bunny 4K TrueHD 5.1 in the VLC-preference fallback transcode came out as AAC 2.0.
        var settings = new TranscodingSettings { AllowSurroundAudio = allowSurroundAudio };
        var media = Media(codec: "mpeg2video", audioCodec: "truehd", channels: 6);

        var plan = Decide(media, RockTv, settings: settings);
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(plan, settings)));

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Equal(("eac3", false, 6, 640, "ec-3"), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels, plan.Audio.BitrateKbps, plan.Audio.CodecsTag));
        Assert.Contains("-c:a eac3 -ac 6 -b:a 640k", args);
        var reason = Assert.Single(plan.Reasons, r => r.Code == "audio_converted");
        Assert.Equal(("truehd", "eac3", "6"), (reason.Params!["from"], reason.Params["to"], reason.Params["channels"]));
        Assert.Contains("ec-3", plan.CodecsAttribute);
    }

    [Fact]
    public void Transcode_AacSurround_StillNeedsTheSetting_ForAPlayerThatDecodesSixChannelsButNoDolby()
    {
        var browser = new ClientProfile { VideoCodecs = ["h264"], AudioCodecs = ["aac"], Containers = ["mp4"], MaxAudioChannels = 6 };
        var media = Media(codec: "mpeg2video", audioCodec: "truehd", channels: 6);

        var off = Decide(media, browser);
        var on = Decide(media, browser, settings: new TranscodingSettings { AllowSurroundAudio = true });

        Assert.Equal(("aac", 2), (off.Audio!.Codec, off.Audio.Channels));
        Assert.Equal(("aac", 6), (on.Audio!.Codec, on.Audio.Channels));
    }

    [Theory]
    [InlineData(2, false, "aac", 2)]
    [InlineData(6, false, "eac3", 6)]
    [InlineData(6, true, "eac3", 6)]
    public void Transcode_GivesAppleTvEac3Surround_OnlyWhenItsProfileDeclaresEac3_AndItsRouteTakesSurround(
        int maxChannels, bool passthrough, string codec, int channels)
    {
        // The tvOS probe declares AC-3/E-AC-3 decode and adds E-AC-3 passthrough only on a multichannel HDMI route.
        var appleTv = new ClientProfile
        {
            VideoCodecs = ["h264", "hevc"], AudioCodecs = ["aac", "ac3", "eac3", "flac"], Containers = ["mp4"],
            MaxAudioChannels = maxChannels, PassthroughAudioCodecs = passthrough ? ["eac3"] : [],
        };
        var media = Media(codec: "mpeg2video", audioCodec: "truehd", channels: 6);

        var plan = Decide(media, appleTv);
        var withoutDolby = Decide(media, appleTv with { AudioCodecs = ["aac", "flac"], PassthroughAudioCodecs = [] });

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Equal((codec, channels), (plan.Audio!.Codec, plan.Audio.Channels));
        Assert.Equal(("aac", 2), (withoutDolby.Audio!.Codec, withoutDolby.Audio.Channels));
    }

    [Theory]
    [InlineData("ac3", 6, "ac3", true, 6)]
    [InlineData("truehd", 6, "ac3", false, 6)]
    [InlineData("aac", 2, "aac", true, 2)]
    public void Transcode_WithoutAnEncoderForTheSelectedCodec_KeepsEachRenditionsOwnPlan(
        string secondCodec, int secondChannels, string expectedCodec, bool expectedCopy, int expectedChannels)
    {
        // An ffmpeg build without the eac3 encoder: the copied E-AC-3 track cannot set the group codec for the other renditions.
        var noEac3 = Capabilities() with { Encoders = new HashSet<string>(Capabilities().Encoders) { "ac3" } };
        var media = Media(codec: "mpeg2video", audioCodec: "eac3", channels: 6) with
        {
            Audio =
            [
                new SourceAudioStream { Index = 1, Codec = "eac3", Channels = 6, Language = "ger", SampleRate = 48_000, IsDefault = true },
                new SourceAudioStream
                {
                    Index = 2, Codec = secondCodec, Channels = secondChannels, Profile = secondCodec == "aac" ? "LC" : null, Language = "eng", SampleRate = 48_000,
                },
            ],
        };

        var plan = TranscodePlanner.Decide(media, RockTv, new TranscodeLimits(AudioStreamIndex: 1, AudioRenditions: [1, 2]), new TranscodingSettings(), noEac3,
            ModePreference.Auto, allowDirect: true);
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(plan, capabilities: noEac3)));

        Assert.Equal(DeliveryMode.Transcode, plan.Mode);
        Assert.Equal(("eac3", true), (plan.AudioRenditions[0].Target.Codec, plan.AudioRenditions[0].Target.Copy));
        var second = plan.AudioRenditions[1].Target;
        Assert.Equal((expectedCodec, expectedCopy, expectedChannels), (second.Codec, second.Copy, second.Channels));
        Assert.DoesNotContain("-c:a:0 eac3", args);
        Assert.DoesNotContain("-c:a:1 eac3", args);
        Assert.Contains("-c:a:0 copy", args);
    }

    [Theory]
    [InlineData(3, 3, 448)]
    [InlineData(4, 4, 448)]
    [InlineData(6, 6, 640)]
    [InlineData(8, 6, 640)]
    public void DolbyTarget_KeepsTheSourceChannelsUpTo51_WithAMatchingBitrate(int sourceChannels, int channels, int kbps)
    {
        var transcode = Decide(Media(codec: "mpeg2video", audioCodec: "truehd", channels: sourceChannels), RockTv);
        var remux = Decide(Media(audioCodec: "truehd", channels: sourceChannels), RockTv);
        var args = string.Join(' ', FfmpegArgumentBuilder.Build(Spec(transcode)));

        foreach (var plan in new[] { transcode, remux })
        {
            Assert.Equal(("eac3", false, channels, kbps), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels, plan.Audio.BitrateKbps));
            Assert.Equal(channels.ToString(), plan.Reasons.Single(r => r.Code == "audio_converted").Params!["channels"]);
        }
        Assert.Contains($"-c:a eac3 -ac {channels} -b:a {kbps}k", args);
    }

    [Fact]
    public void DolbyRenditions_AnnounceTheirRealChannelCount_InTheMasterPlaylist()
    {
        var media = Media(codec: "mpeg2video", audioCodec: "truehd", channels: 4) with
        {
            Audio =
            [
                new SourceAudioStream { Index = 1, Codec = "truehd", Channels = 4, Language = "ger", SampleRate = 48_000, IsDefault = true },
                new SourceAudioStream { Index = 2, Codec = "dts", Channels = 3, Language = "eng", SampleRate = 48_000 },
            ],
        };

        var plan = Decide(media, RockTv, limits: new TranscodeLimits(AudioStreamIndex: 1, AudioRenditions: [1, 2]));
        var master = HlsPlaylist.Master(plan);

        Assert.Equal([(4, 448), (3, 448)], plan.AudioRenditions.Select(r => (r.Target.Channels, r.Target.BitrateKbps)));
        Assert.Contains("CHANNELS=\"4\"", master);
        Assert.Contains("CHANNELS=\"3\"", master);
        Assert.DoesNotContain("CHANNELS=\"6\"", master);
    }

    [Fact]
    public void Transcode_ForAPlayerWithoutPassthrough_StillConvertsToAac()
    {
        var plan = Decide(Media(codec: "mpeg2video", audioCodec: "eac3", channels: 6), RockTv with { PassthroughAudioCodecs = [] });

        Assert.Equal(("aac", false, 2), (plan.Audio!.Codec, plan.Audio.Copy, plan.Audio.Channels));
    }
}
