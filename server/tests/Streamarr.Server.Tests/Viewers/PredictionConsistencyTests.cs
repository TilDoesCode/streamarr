using Streamarr.Core.Parser;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Controllers;
using Streamarr.Server.Viewers.Playback;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>
/// The versions prediction (release name + the compact hints the client sends) and the playback start (the probed file + the full
/// device profile) choose the same method, output height and range for every release × device, with the same reasons.
/// </summary>
public sealed class PredictionConsistencyTests
{
    private static readonly ServerHls Server = FakePlaybackMedia.Available();
    private static readonly PlaybackPredictor Predictor = new(null!);
    private static readonly IReadOnlySet<string> NoExclusions = new HashSet<string>();
    private static readonly string[] Assumptions = ["container_assumed", "audio_codec_unknown", "resolution_assumed", "bit_depth_assumed", "dolby_vision_profile_unknown"];
    private const string Mp4 = "mov,mp4,m4a,3gp,3g2,mj2";

    private static SourceMediaInfo Uhd(HdrFormat hdr, string audio, int channels, int? dvProfile = null, int? dvCompatibility = null, string? transfer = "smpte2084")
        => Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: hdr, audioCodec: audio, channels: channels,
            dvProfile: dvProfile, dvCompatibility: dvCompatibility, colorTransfer: transfer);

    /// <summary>Release shapes of the reported HDR bugs and common cases, each with what ffprobe reports for the real file.</summary>
    public static readonly (string Name, SourceMediaInfo Real)[] Releases =
    [
        ("Sample.Show.S06E01.German.DL.2160p.WEB.H265.HDR10.DDP5.1-ALPHA", Uhd(HdrFormat.Hdr10, "eac3", 6)),
        ("Sample.Show.S06E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-BETA", Uhd(HdrFormat.DolbyVision, "eac3", 6, 8, 1)),
        ("Sample.Show.S06E01.2160p.ATVP.WEB-DL.DDP5.1.DV.HDR10.H.265-GAMMA", Uhd(HdrFormat.DolbyVision, "eac3", 6, 8, 1)),
        ("Sample.Show.2022.S06E01.German.DL.AC3.2160p.DV.HDR.ATV.WEB.H265-DELTA", Uhd(HdrFormat.DolbyVision, "ac3", 2, 8, 1)),
        ("Movie.2019.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP", Uhd(HdrFormat.DolbyVision, "truehd", 8, 7, 6)),
        ("Movie.2023.2160p.WEB-DL.DV.H265.DDP5.1-GRP", Uhd(HdrFormat.DolbyVision, "eac3", 6, 5, 0, transfer: null)),
        ("Movie.2019.2160p.UHD.BluRay.x265.10bit.HDR10.TrueHD.7.1-GRP", Uhd(HdrFormat.Hdr10, "truehd", 8)),
        ("Big.Buck.Bunny.2008.2160p.UHD.BluRay.TrueHD.5.1.HDR10.x265-DEVWORLD", Uhd(HdrFormat.Hdr10, "truehd", 6)),
        ("Nature.Film.2023.2160p.WEB-DL.HLG.H265.AAC2.0-GRP", Uhd(HdrFormat.Hlg, "aac", 2, transfer: "arib-std-b67")),
        ("Movie.2019.2160p.WEB-DL.x265.AAC2.0-GRP", Media(codec: "hevc", width: 3840, height: 2160, audioCodec: "aac", channels: 2)),
        ("Movie.2019.1080p.WEB-DL.x265.DDP5.1-GRP", Media(codec: "hevc", audioCodec: "eac3", channels: 6)),
        ("Movie.2019.1080p.WEB-DL.H264.AAC2.0.MP4-GRP", Media(container: Mp4, audioCodec: "aac", channels: 2)),
        ("Movie.2019.720p.HDTV.MPEG2.AC3.2.0-GRP", Media(codec: "mpeg2video", width: 1280, height: 720, audioCodec: "ac3", channels: 2)),
    ];

    private static VideoCodecProfileDto V(string codec, int height, int depth, params string[] hdr)
        => new() { Codec = codec, MaxWidth = height * 16 / 9, MaxHeight = height, MaxBitDepth = depth, HdrFormats = hdr };

    private static AudioCodecProfileDto A(string codec, int? channels = null, bool passthrough = false) => new() { Codec = codec, MaxChannels = channels, Passthrough = passthrough };

    private static readonly string[] ExoContainers = ["mp4", "mkv", "webm", "ts", "mpeg", "avi", "ogg", "flv"];
    private static readonly string[] ExoSubtitles = ["srt", "ass", "ssa", "webvtt", "mov_text", "pgs", "vobsub", "dvbsub"];

    private static EngineProfileDto Vlc(int height, int channels) => new()
    {
        Engine = "vlc",
        Containers = ["mkv", "mp4", "webm", "ts", "mpeg", "avi", "ogg", "flv", "asf"],
        VideoCodecs = [V("h264", height, 8), V("hevc", height, 10), V("av1", height, 10), V("vp9", height, 10), V("mpeg2video", 1080, 8), V("vc1", 1080, 8)],
        AudioCodecs = new[] { "aac", "ac3", "eac3", "truehd", "dts", "flac", "opus", "mp3" }.Select(c => A(c, 8)).ToArray(),
        SubtitleFormats = ExoSubtitles,
        Hls = true,
        MaxAudioChannels = channels,
    };

    /// <summary>What the media-caps probe reports on the Radxa Rock 4D (RK3576) at the LG C1: HDR10/HLG display, no Dolby Vision, HDMI bitstream.</summary>
    internal static readonly DeviceProfileDto Rock4D = new()
    {
        Platform = "androidtv",
        VlcAvailable = true,
        Engines =
        [
            new EngineProfileDto
            {
                Engine = "native",
                Containers = ExoContainers,
                VideoCodecs = [V("h264", 4320, 8), V("hevc", 4320, 10, "hdr10", "hlg"), V("av1", 4320, 10, "hdr10", "hlg"), V("vp9", 4320, 10, "hdr10", "hlg")],
                AudioCodecs = [A("aac", 8), A("flac", 8), A("mp3", 2), A("opus", 8), A("ac3", passthrough: true), A("eac3", passthrough: true), A("dts", passthrough: true)],
                SubtitleFormats = ExoSubtitles,
                Hls = true,
                MaxAudioChannels = 2,
            },
            Vlc(4320, 2),
        ],
    };

    private static readonly DeviceProfileDto DolbyVisionTv = new()
    {
        Platform = "androidtv",
        VlcAvailable = true,
        Engines =
        [
            new EngineProfileDto
            {
                Engine = "native",
                Containers = ExoContainers,
                VideoCodecs = [V("h264", 2160, 8), V("hevc", 2160, 10, "hdr10", "hlg", "dolbyvision"), V("av1", 2160, 10, "hdr10", "hlg", "dolbyvision")],
                AudioCodecs = [A("aac", 8), A("opus", 8), A("ac3", passthrough: true), A("eac3", passthrough: true), A("truehd", passthrough: true), A("dts", passthrough: true)],
                SubtitleFormats = ExoSubtitles,
                Hls = true,
                MaxAudioChannels = 8,
            },
            Vlc(2160, 8),
        ],
    };

    private static DeviceProfileDto Chrome(bool hdr) => new()
    {
        Platform = "web",
        Engines =
        [
            new EngineProfileDto
            {
                Engine = "web",
                Containers = ["mp4", "webm"],
                VideoCodecs = [V("h264", 2160, 8), V("hevc", 2160, 10, hdr ? ["hdr10"] : []), V("av1", 2160, 10, hdr ? ["hdr10"] : []), V("vp9", 2160, 10, hdr ? ["hdr10"] : [])],
                AudioCodecs = [A("aac", 2), A("opus", 2), A("flac", 2)],
                SubtitleFormats = ["webvtt"],
                Hls = true,
                MaxAudioChannels = 2,
            },
        ],
    };

    private static readonly DeviceProfileDto AppleTv = new()
    {
        Platform = "tvos",
        Engines =
        [
            new EngineProfileDto
            {
                Engine = "native",
                Containers = ["mp4"],
                VideoCodecs = [V("h264", 2160, 8), V("hevc", 2160, 10, "hdr10", "hlg", "dolbyvision")],
                AudioCodecs = [A("aac", 8), A("ac3", 6), A("eac3", passthrough: true), A("flac", 8)],
                SubtitleFormats = ["webvtt", "mov_text"],
                Hls = true,
                MaxAudioChannels = 6,
            },
        ],
    };

    public static readonly (string Name, DeviceProfileDto Profile)[] Devices =
        [("rock4d", Rock4D), ("dolby-vision-tv", DolbyVisionTv), ("chrome-sdr", Chrome(false)), ("chrome-hdr", Chrome(true)), ("apple-tv", AppleTv)];

    private static readonly string[] Engines = ["auto", "native", "vlc"];

    public static TheoryData<string, string, string> Matrix()
    {
        var data = new TheoryData<string, string, string>();
        foreach (var device in Devices)
        {
            foreach (var release in Releases)
            {
                foreach (var engine in Engines)
                    data.Add(device.Name, release.Name, engine);
            }
        }
        return data;
    }

    /// <summary>The compact hints <c>versionHints()</c> builds from a full profile, parsed like the versions endpoint does.</summary>
    internal static DeviceCaps HintsCaps(DeviceProfileDto profile, bool vlcHdrFormats = true)
    {
        var native = profile.Engines!.First(e => e.Engine != "vlc");
        var video = native.VideoCodecs!;
        var hdr = video.SelectMany(v => v.HdrFormats ?? []).Distinct().ToList();
        var client = new ClientProfile
        {
            VideoCodecs = video.Select(v => v.Codec!).ToList(),
            AudioCodecs = native.AudioCodecs!.Select(a => a.Codec!).ToList(),
            PassthroughAudioCodecs = native.AudioCodecs!.Where(a => a.Passthrough).Select(a => a.Codec!).ToList(),
            Containers = native.Containers!,
            HdrFormats = hdr,
            SupportsHdr = hdr.Count > 0,
            Supports10Bit = video.Any(v => v.MaxBitDepth >= 10),
            MaxAudioChannels = native.MaxAudioChannels ?? 2,
        };
        var maxHeight = video.Max(v => v.MaxHeight);
        var hints = new DeviceHints(client, new TranscodeLimits(maxHeight is { } h ? Math.Clamp(h, 144, 4320) : null, profile.MaxBitrateKbps));
        var vlcEngine = profile.Engines!.FirstOrDefault(e => e.Engine == "vlc");
        var vlc = profile.VlcAvailable && vlcEngine is not null && profile.Platform is "android" or "androidtv" or "ios" or "ipados"
            ? ViewerCatalogController.VlcCaps(
                string.Join(',', vlcEngine.VideoCodecs!.Select(v => v.MaxHeight is { } height ? $"{v.Codec}:{height}" : v.Codec)), null,
                vlcHdrFormats ? string.Join(',', vlcEngine.VideoCodecs!.SelectMany(v => v.HdrFormats ?? []).Distinct()) is { Length: > 0 } list ? list : "none" : null,
                vlcEngine.VideoCodecs!.Any(v => v.MaxBitDepth >= 10), false)
            : null;
        return hints.ToCaps(vlc);
    }

    private static string Class(PlaybackCandidate? best) => best switch
    {
        null => PlayClass.Unplayable,
        { Method: DeliveryMode.Direct } when best.Engine.Name == EngineCaps.Vlc => PlayClass.Vlc,
        { Method: DeliveryMode.Direct } => PlayClass.Direct,
        { Method: DeliveryMode.Remux } => PlayClass.Remux,
        _ => PlayClass.Transcode,
    };

    [Theory]
    [MemberData(nameof(Matrix))]
    public void Prediction_MatchesThePlaybackDecision(string deviceName, string releaseName, string engine)
    {
        var profile = Devices.Single(d => d.Name == deviceName).Profile;
        var real = Releases.Single(r => r.Name == releaseName).Real;
        var parsed = ReleaseParser.Parse(releaseName);
        var container = real.Container == Mp4 ? "mp4" : "mkv";
        var preferences = PlaybackPreferences.Default with { Engine = ViewerCatalogController.Engine(engine) };

        var (predictedClass, prediction) = Predictor.ClassifyAndExplain(
            parsed, 6000, 60, new PlayContext(HintsCaps(profile), preferences, Server), true, container);
        var decision = PlaybackDecider.Decide(real, DeviceCaps.Parse(profile), preferences, true, Server, null, null, NoExclusions);
        var best = decision.Viable.FirstOrDefault();

        Assert.Equal(Class(best), predictedClass);
        Assert.Equal(predictedClass, prediction.Method);
        Assert.NotNull(best);
        Assert.Equal(best.Plan.Video.Height, prediction.Height);
        Assert.Equal(best.DisplayedHdr == HdrFormat.None ? "sdr" : best.DisplayedHdr.ToApi(), prediction.Hdr);
        var realCodes = decision.Notes.Concat(best.Notes).Concat(best.Plan.Reasons).Select(r => r.Code).ToHashSet();
        var predictedCodes = prediction.Reasons.Select(r => r.Code).Except(Assumptions).ToHashSet();
        Assert.Equal(realCodes.Order(), predictedCodes.Order());
        if (PlayClass.WithoutTranscode(predictedClass))
            Assert.Contains(best.Plan.Encoder, new[] { "none", "copy" });
    }

    private static PlaybackPreferences Engine(EnginePreference engine, bool force = false) => PlaybackPreferences.Default with { Engine = engine, ForceEngine = force };

    private static SourceMediaInfo TearsOfSteel(string audio, int channels) => Media(audioCodec: audio, channels: channels);

    [Theory]
    [InlineData(EnginePreference.Auto)]
    [InlineData(EnginePreference.Native)]
    [InlineData(EnginePreference.Vlc)]
    public void Rock4D_4kHdr10TrueHd_PlaysTheNativeRemux_WhateverThePreference_KeepingHdr10AndSurround(EnginePreference engine)
    {
        // Device check 15:30: VLC preferred ended in an H.264 SDR transcode; the native remux keeps HDR10 and 5.1 (TrueHD → E-AC-3).
        var bbb = Releases.Single(r => r.Name.StartsWith("Big.Buck.Bunny", StringComparison.Ordinal));
        var parsed = ReleaseParser.Parse(bbb.Name);

        var start = PlaybackDecider.Decide(bbb.Real, DeviceCaps.Parse(Rock4D), Engine(engine), true, Server, null, null, NoExclusions);
        var (predicted, prediction) = Predictor.ClassifyAndExplain(parsed, 6000, 60, new PlayContext(HintsCaps(Rock4D), Engine(engine), Server), true, "mkv");

        var best = start.Viable[0];
        Assert.Equal((DeliveryMode.Remux, EngineCaps.Native), (best.Method, best.Engine.Name));
        Assert.Equal(HdrFormat.Hdr10, best.DisplayedHdr);
        Assert.Equal(("eac3", false, 6), (best.Plan.Audio!.Codec, best.Plan.Audio.Copy, best.Plan.Audio.Channels));
        Assert.Contains(start.Skipped, s => s is { Method: DeliveryMode.Direct, Engine: EngineCaps.Vlc } && s.Reasons.Any(r => r.Code == "hdr_unsupported"));
        Assert.Equal((PlayClass.Remux, "hdr10", 2160), (predicted, prediction.Hdr, prediction.Height));
        Assert.Equal(engine == EnginePreference.Vlc, best.Notes.Any(n => n is { Code: "better_engine" } && n.Params!["preferred"] == "vlc"));
        Assert.Equal(engine == EnginePreference.Vlc, prediction.Reasons.Any(r => r.Code == "better_engine"));
    }

    [Theory]
    [InlineData(8, 1, "smpte2084", "Movie.2024.2160p.WEB-DL.DDP5.1.DV.HDR10.H.265-GRP", DeliveryMode.Direct, HdrFormat.Hdr10)]
    [InlineData(8, 4, "arib-std-b67", "Movie.2024.2160p.WEB-DL.DDP5.1.DV.HLG.H.265-GRP", DeliveryMode.Direct, HdrFormat.Hlg)]
    [InlineData(7, 6, "smpte2084", "Movie.2024.2160p.BluRay.REMUX.DV.HDR10.HEVC.DDP5.1-GRP", DeliveryMode.Remux, HdrFormat.Hdr10)]
    [InlineData(5, 0, "smpte2084", "Movie.2024.2160p.WEB-DL.DDP5.1.DV.H.265-GRP", DeliveryMode.Transcode, HdrFormat.None)]
    public void Rock4D_DolbyVision_PlaysTheBaseLayerNatively_OrTranscodesProfile5(
        int profile, int compatibility, string transfer, string release, DeliveryMode method, HdrFormat shown)
    {
        // DV issue 2026-10-26: no DV decoder, HEVC Main10 with HDR10/HLG; the decider and the version list agree per profile.
        var media = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.DolbyVision, audioCodec: "eac3",
            dvProfile: profile, dvCompatibility: compatibility, colorTransfer: transfer);

        var best = PlaybackDecider.Decide(media, DeviceCaps.Parse(Rock4D), PlaybackPreferences.Default, true, Server, null, null, NoExclusions).Viable[0];
        var (_, prediction) = Predictor.ClassifyAndExplain(ReleaseParser.Parse(release), 20000, 120, new PlayContext(HintsCaps(Rock4D), PlaybackPreferences.Default, Server), true, "mkv");

        Assert.Equal((method, EngineCaps.Native, shown), (best.Method, best.Engine.Name, best.DisplayedHdr));
        Assert.Equal(method.ToApi(), prediction.Method);
        Assert.Equal(shown == HdrFormat.None ? "sdr" : shown.ToApi(), prediction.Hdr);
        Assert.Contains(profile == 5 ? "dolby_vision_profile_unsupported" : "dolby_vision_base_layer", best.Plan.Reasons.Select(r => r.Code));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Rock4D_ForcedVlc_FallsBackToTheTranscode_KeepingTrueHdSurroundAsEac3(bool allowSurroundAudio)
    {
        // "Use VLC" after a failure forces the engine: VLC cannot show HDR10 here, so only a transcode remains (as before).
        var bbb = Releases.Single(r => r.Name.StartsWith("Big.Buck.Bunny", StringComparison.Ordinal)).Real;
        var server = Server with { Settings = new TranscodingSettings { AllowSurroundAudio = allowSurroundAudio } };

        var start = PlaybackDecider.Decide(bbb, DeviceCaps.Parse(Rock4D), Engine(EnginePreference.Vlc, force: true), true, server, null, null, NoExclusions);

        var chosen = start.Viable[0];
        Assert.Equal((DeliveryMode.Transcode, EngineCaps.Native), (chosen.Method, chosen.Engine.Name));
        Assert.DoesNotContain(start.Viable, c => c.Method == DeliveryMode.Remux);
        Assert.Equal(("eac3", false, 6, 640), (chosen.Plan.Audio!.Codec, chosen.Plan.Audio.Copy, chosen.Plan.Audio.Channels, chosen.Plan.Audio.BitrateKbps));
        Assert.Contains(chosen.Notes, r => r.Code == "transcode_native_engine");
    }

    [Theory]
    [InlineData("aac", 2, 2, EnginePreference.Auto, EngineCaps.Native)]
    [InlineData("aac", 2, 2, EnginePreference.Native, EngineCaps.Native)]
    [InlineData("aac", 2, 2, EnginePreference.Vlc, EngineCaps.Vlc)]
    [InlineData("eac3", 6, 2, EnginePreference.Auto, EngineCaps.Native)]
    [InlineData("eac3", 6, 2, EnginePreference.Vlc, EngineCaps.Native)]
    [InlineData("eac3", 6, 8, EnginePreference.Vlc, EngineCaps.Vlc)]
    [InlineData("eac3", 6, 8, EnginePreference.Native, EngineCaps.Native)]
    public void TearsOfSteel1080p_EqualPlaybacks_FollowThePreference_ButAStereoDownmixLoses(
        string audio, int channels, int outputChannels, EnginePreference engine, string expected)
    {
        // libVLC runs without passthrough: it decodes Dolby to PCM, so a 2-channel output gets a downmix where the native engine bitstreams 5.1.
        var device = Rock4D with
        {
            Engines = [Rock4D.Engines![0] with { MaxAudioChannels = outputChannels }, Vlc(4320, outputChannels)],
        };
        var source = TearsOfSteel(audio, channels);

        var start = PlaybackDecider.Decide(source, DeviceCaps.Parse(device), Engine(engine), true, Server, null, null, NoExclusions);
        var (predicted, _) = Predictor.ClassifyAndExplain(ReleaseParser.Parse($"Tears.of.Steel.2012.1080p.BluRay.{(audio == "aac" ? "AAC2.0" : "DDP5.1")}.x264-GRP"),
            6000, 60, new PlayContext(HintsCaps(device), Engine(engine), Server), true, "mkv");

        Assert.Equal((DeliveryMode.Direct, expected), (start.Viable[0].Method, start.Viable[0].Engine.Name));
        Assert.Equal(expected == EngineCaps.Vlc ? PlayClass.Vlc : PlayClass.Direct, predicted);
    }

    [Fact]
    public void Rock4D_DolbyVisionWithAnHdr10BaseLayer_PlaysDirectInHdr10_WithDolbyDigitalPlusAsABitstream()
    {
        var decision = PlaybackDecider.Decide(Uhd(HdrFormat.DolbyVision, "eac3", 6, 8, 1), DeviceCaps.Parse(Rock4D), PlaybackPreferences.Default,
            true, Server, null, null, NoExclusions);

        var best = decision.Viable[0];
        Assert.Equal((DeliveryMode.Direct, EngineCaps.Native), (best.Method, best.Engine.Name));
        Assert.Equal(HdrFormat.Hdr10, best.DisplayedHdr);
        Assert.Equal(("hdr10", "8"), (best.Plan.Reasons.Single(r => r.Code == "dolby_vision_base_layer").Params!["hdr"],
            best.Plan.Reasons.Single(r => r.Code == "dolby_vision_base_layer").Params!["profile"]));
        Assert.Equal(("eac3", 6), (best.Plan.Audio!.Codec, best.Plan.Audio.Channels));
        Assert.Equal(ToneMapMode.NotNeeded, best.Plan.ToneMap);
    }

    [Fact]
    public void Rock4D_RemuxedDolbyVision_KeepsTheBaseLayer_AndCopiesTheBitstreamAudio()
    {
        var mp4Only = Rock4D with { Engines = [Rock4D.Engines![0] with { Containers = ["mp4"] }] };
        var decision = PlaybackDecider.Decide(Uhd(HdrFormat.DolbyVision, "eac3", 6, 8, 1), DeviceCaps.Parse(mp4Only), PlaybackPreferences.Default,
            true, Server, null, null, NoExclusions);

        var best = decision.Viable[0];
        Assert.Equal(DeliveryMode.Remux, best.Method);
        Assert.Equal(("copy", "PQ", HdrFormat.Hdr10), (best.Plan.Encoder, best.Plan.VideoRange, best.DisplayedHdr));
        Assert.Equal(("eac3", true, 6), (best.Plan.Audio!.Codec, best.Plan.Audio.Copy, best.Plan.Audio.Channels));
        Assert.DoesNotContain(best.Plan.Reasons, r => r.Code is "hdr_unsupported" or "audio_converted");
    }

    [Fact]
    public void Rock4D_BluRayProfile7_IsRemuxed_AndProfile5_IsTranscodedIn4K()
    {
        var device = DeviceCaps.Parse(Rock4D);
        var p7 = PlaybackDecider.Decide(Uhd(HdrFormat.DolbyVision, "eac3", 6, 7, 6), device, PlaybackPreferences.Default, true, Server, null, null, NoExclusions);
        var p5 = PlaybackDecider.Decide(Uhd(HdrFormat.DolbyVision, "eac3", 6, 5, 0, transfer: null), device, PlaybackPreferences.Default, true, Server, null, null, NoExclusions);

        Assert.Equal(DeliveryMode.Remux, p7.Viable[0].Method);
        Assert.Contains(p7.Skipped, s => s is { Method: DeliveryMode.Direct, Engine: EngineCaps.Native } && s.Reasons.Any(r => r.Code == "dolby_vision_dual_layer"));
        Assert.Equal(DeliveryMode.Transcode, p5.Viable[0].Method);
        Assert.Equal(2160, p5.Viable[0].Plan.Video.Height);
        Assert.Contains(p5.Viable[0].Plan.Reasons, r => r.Code == "dolby_vision_profile_unsupported");
        Assert.DoesNotContain(p5.Viable[0].Notes, r => r.Code == "transcode_height_limited");
        Assert.Equal(("eac3", true), (p5.Viable[0].Plan.Audio!.Codec, p5.Viable[0].Plan.Audio!.Copy));
    }

    [Fact]
    public void Rock4D_TheOldProbe_WithoutHdr10OnHevc_TranscodedHdr10ToSdr()
    {
        var old = Rock4D with
        {
            Engines = [Rock4D.Engines![0] with { VideoCodecs = [V("h264", 4320, 8), V("hevc", 4320, 10, "hlg"), V("vp9", 4320, 10, "hdr10", "hlg")] }, Rock4D.Engines![1]],
        };
        var decision = PlaybackDecider.Decide(Uhd(HdrFormat.DolbyVision, "eac3", 6, 8, 1), DeviceCaps.Parse(old), PlaybackPreferences.Default,
            true, Server, null, null, NoExclusions);

        Assert.Equal(DeliveryMode.Transcode, decision.Viable[0].Method);
        Assert.Equal(HdrFormat.None, decision.Viable[0].DisplayedHdr);
        Assert.Contains(decision.Skipped, s => s.Method == DeliveryMode.Remux && s.Reasons.Any(r => r is { Code: "hdr_unsupported" }));
    }
}
