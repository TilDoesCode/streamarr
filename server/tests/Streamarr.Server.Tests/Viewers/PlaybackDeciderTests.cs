using Streamarr.Server.Tests.Transcoding;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Playback;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>PLAN §2 ranking, image-subtitle rules, preferences, device limits and track selection, without a server.</summary>
public sealed class PlaybackDeciderTests
{
    private static readonly ServerHls Server = FakePlaybackMedia.Available();
    private static readonly IReadOnlySet<string> None = new HashSet<string>();

    private static EngineProfileDto Engine(
        string engine, string[] containers, VideoCodecProfileDto[] video, AudioCodecProfileDto[] audio, string[]? subtitles, int channels = 6, bool hls = true)
        => new() { Engine = engine, Containers = containers, VideoCodecs = video, AudioCodecs = audio, SubtitleFormats = subtitles, MaxAudioChannels = channels, Hls = hls };

    private static VideoCodecProfileDto V(string codec, int? depth = null, int? maxHeight = null, params string[] hdr)
        => new() { Codec = codec, MaxBitDepth = depth, MaxHeight = maxHeight, HdrFormats = hdr };

    private static AudioCodecProfileDto A(string codec, bool passthrough = false, int? max = null) => new() { Codec = codec, Passthrough = passthrough, MaxChannels = max };

    private static DeviceCaps AppleTv(bool vlc = false, int? bandwidth = null) => DeviceCaps.Parse(new DeviceProfileDto
    {
        Platform = "tvos",
        VlcAvailable = vlc,
        MaxBitrateKbps = bandwidth,
        Engines = [Engine("native", ["mp4"], [V("h264"), V("hevc", 10, null, "hdr10", "hlg")], [A("aac"), A("ac3"), A("eac3")], ["webvtt", "mov_text"])],
    });

    internal static DeviceCaps AndroidTv() => DeviceCaps.Parse(new DeviceProfileDto
    {
        Platform = "androidtv",
        VlcAvailable = true,
        Engines =
        [
            Engine("native", ["mp4", "mkv"], [V("h264"), V("hevc", 10, null, "hdr10"), V("av1", 10)],
                [A("aac"), A("opus"), A("ac3", true), A("eac3", true), A("dts", true)], ["srt", "ass", "pgs"]),
        ],
    });

    internal static DeviceCaps Chrome(bool hdr = false) => DeviceCaps.Parse(new DeviceProfileDto
    {
        Platform = "web",
        Engines = [Engine("web", ["mp4", "webm"], [V("h264"), V("av1", 10), V("hevc", 10, null, hdr ? ["hdr10"] : [])], [A("aac"), A("opus")], ["webvtt"], channels: 2)],
    });

    private static SourceMediaInfo Mp4() => Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2);

    private static SourceMediaInfo Mkv(params SourceSubtitleStream[] subtitles) => Media(audioCodec: "eac3", channels: 6, subtitles: subtitles);

    private static SourceMediaInfo Pgs() => Mkv(Subtitle(2, "hdmv_pgs_subtitle", "ger"), Subtitle(3, "subrip", "eng"));

    private static PlaybackPreferences Prefs(EnginePreference engine = EnginePreference.Auto, int? maxHeight = null, string? subtitleLanguage = null,
        SubtitleMode mode = SubtitleMode.Forced, string? audioLanguage = null, int? maxBitrate = null)
        => new(engine, maxHeight, maxBitrate, audioLanguage, subtitleLanguage, mode);

    private static PlaybackDecision Decide(SourceMediaInfo media, DeviceCaps device, PlaybackPreferences? prefs = null, bool allowTranscoding = true,
        ServerHls? server = null, int? audio = null, int? subtitle = null, IReadOnlySet<string>? excluded = null)
        => PlaybackDecider.Decide(media, device, prefs ?? Prefs(), allowTranscoding, server ?? Server, audio, subtitle, excluded ?? None);

    private static (DeliveryMode, string) First(PlaybackDecision decision) => (decision.Viable[0].Method, decision.Viable[0].Engine.Name);

    private static IEnumerable<string> Codes(IEnumerable<PlanReason> reasons) => reasons.Select(r => r.Code);

    [Fact]
    public void Mp4H264Aac_PlaysDirect_OnEveryNativeEngine()
    {
        foreach (var device in new[] { AppleTv(), AndroidTv(), Chrome() })
        {
            var decision = Decide(Mp4(), device);
            Assert.Equal(DeliveryMode.Direct, First(decision).Item1);
            Assert.Equal(device.Native!.Name, First(decision).Item2);
            Assert.Empty(decision.Skipped);
        }
    }

    [Fact]
    public void Mkv_OnAppleTv_IsRemuxedNatively_BeforeVlc_AndVlcComesBeforeATranscode()
    {
        var decision = Decide(Mkv(), AppleTv(vlc: true));

        Assert.Equal([(DeliveryMode.Remux, "native"), (DeliveryMode.Direct, "vlc"), (DeliveryMode.Transcode, "native")],
            decision.Viable.Select(c => (c.Method, c.Engine.Name)));
        var skipped = Assert.Single(decision.Skipped);
        Assert.Equal((DeliveryMode.Direct, "native"), (skipped.Method, skipped.Engine));
        Assert.Contains("container_unsupported", Codes(skipped.Reasons));
        Assert.Equal(DeliveryMode.Remux, decision.Viable[0].Plan.Mode);
    }

    [Fact]
    public void Mkv_OnAndroidTv_PlaysDirect_WithPassthroughAudio()
    {
        var decision = Decide(Mkv(), AndroidTv());

        Assert.Equal((DeliveryMode.Direct, "native"), First(decision));
    }

    [Fact]
    public void Av1_OnAppleTv_PlaysWithVlc_WhenAvailable_ElseTranscodes()
    {
        var av1 = Media(codec: "av1", audioCodec: "opus", channels: 6);

        var withVlc = Decide(av1, AppleTv(vlc: true));
        var withoutVlc = Decide(av1, AppleTv());

        Assert.Equal((DeliveryMode.Direct, "vlc"), First(withVlc));
        Assert.Contains("vlc_fallback", Codes(withVlc.Viable[0].Notes));
        Assert.Contains(withVlc.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("video_codec_unsupported"));
        Assert.Equal((DeliveryMode.Transcode, "native"), First(withoutVlc));
    }

    [Fact]
    public void WithoutTranscoding_ALegacySourceFails_ButAStreamCopyStillWorks()
    {
        var mpeg2 = Media(codec: "mpeg2video", width: 720, height: 576, container: "mpeg", audioCodec: "ac3", channels: 2);

        var legacy = Decide(mpeg2, Chrome(), allowTranscoding: false);
        var remux = Decide(Mkv(), Chrome(), allowTranscoding: false);

        Assert.Empty(legacy.Viable);
        Assert.Equal("transcoding_not_allowed", legacy.Failure!.Code);
        Assert.Equal([SuggestedActions.OtherVersion], legacy.Failure.SuggestedActions);
        Assert.Equal((DeliveryMode.Remux, "web"), First(remux));
        Assert.Contains("audio_converted", Codes(remux.Viable[0].Plan.Reasons));
    }

    [Fact]
    public void EnginePreference_NativeNeverUsesVlc_VlcAlwaysDoes_AndAMissingVlcFallsBackToAuto()
    {
        var av1 = Media(codec: "av1", audioCodec: "opus", channels: 6);

        var native = Decide(av1, AppleTv(vlc: true), Prefs(EnginePreference.Native));
        var vlc = Decide(Mp4(), AppleTv(vlc: true), Prefs(EnginePreference.Vlc));
        var missing = Decide(Mp4(), AppleTv(), Prefs(EnginePreference.Vlc));

        Assert.Equal((DeliveryMode.Transcode, "native"), First(native));
        Assert.DoesNotContain(native.Viable, c => c.Engine.Name == "vlc");
        Assert.Equal((DeliveryMode.Direct, "vlc"), First(vlc));
        Assert.Equal((DeliveryMode.Direct, "native"), First(missing));
        Assert.Contains("vlc_unavailable", Codes(missing.Notes));
    }

    [Fact]
    public void NativePreference_WithoutAnyWayToPlay_SuggestsVlc()
    {
        var mpeg2 = Media(codec: "mpeg2video", width: 720, height: 576, container: "mpeg", audioCodec: "ac3", channels: 2);

        var decision = Decide(mpeg2, AppleTv(vlc: true), Prefs(EnginePreference.Native), allowTranscoding: false);

        Assert.Equal("transcoding_not_allowed", decision.Failure!.Code);
        Assert.Contains(SuggestedActions.UseVlc, decision.Failure.SuggestedActions);
    }

    [Fact]
    public void NativePreference_AfterVlcAlreadyFailed_DoesNotSuggestVlcAgain()
    {
        var mpeg2 = Media(codec: "mpeg2video", width: 720, height: 576, container: "mpeg", audioCodec: "ac3", channels: 2);
        var excluded = new HashSet<string> { PlaybackDecider.Key(DeliveryMode.Direct, EngineCaps.Vlc) };

        var decision = Decide(mpeg2, AppleTv(vlc: true), Prefs(EnginePreference.Native), allowTranscoding: false, excluded: excluded);

        Assert.Equal([SuggestedActions.OtherVersion], decision.Failure!.SuggestedActions);
    }

    [Theory]
    [InlineData(404, "title_not_found", new string[0])]
    [InlineData(404, "episode_not_found", new string[0])]
    [InlineData(403, "age_restricted", new string[0])]
    [InlineData(503, "catalog_unavailable", new[] { "retry" })]
    [InlineData(429, "capacity_reached", new[] { "retry" })]
    [InlineData(400, "invalid_work_id", new[] { "otherVersion" })]
    public void CatalogProblems_DuringPlayback_OnlySuggestActionsThatCanHelp(int status, string code, string[] actions)
        => Assert.Equal(actions, ViewerPlaybackService.ProblemActions(new ViewerProblem(status, code, code)));

    [Fact]
    public void MaxHeightPreference_BelowTheSource_ForcesATranscodeAtThatHeight()
    {
        var uhd = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, audioCodec: "eac3", channels: 6, colorTransfer: "smpte2084");

        var decision = Decide(uhd, AppleTv(vlc: true), Prefs(maxHeight: 720));

        var chosen = decision.Viable[0];
        Assert.Equal((DeliveryMode.Transcode, "native"), (chosen.Method, chosen.Engine.Name));
        Assert.Equal(720, chosen.Plan.Video.Height);
        Assert.Contains(decision.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("resolution_exceeds_limit"));
        Assert.Contains(decision.Skipped, s => s.Engine == "vlc" && Codes(s.Reasons).Contains("resolution_exceeds_limit"));
    }

    [Fact]
    public void BandwidthCapOfTheDevice_BlocksDirectAndRemux_AndBoundsTheTranscode()
    {
        var decision = Decide(Mkv(), AppleTv(bandwidth: 3_000));

        var chosen = decision.Viable[0];
        Assert.Equal(DeliveryMode.Transcode, chosen.Method);
        Assert.Equal(3_000, chosen.Limits.MaxBitrateKbps);
        Assert.True(chosen.Plan.Video.BitrateKbps + (chosen.Plan.Audio?.BitrateKbps ?? 0) <= 3_000);
        Assert.Contains("bandwidth_limit", Codes(decision.Notes));
        Assert.Contains(decision.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("bitrate_exceeds_limit"));
    }

    [Fact]
    public void ImageSubtitle_OnANativeEngineWithoutIt_PrefersVlc()
    {
        var decision = Decide(Pgs(), AppleTv(vlc: true), Prefs(subtitleLanguage: "de", mode: SubtitleMode.Always));

        Assert.Equal((DeliveryMode.Direct, "vlc"), First(decision));
        Assert.Equal(2, decision.Viable[0].Limits.SubtitleStreamIndex);
        Assert.Contains("image_subtitle_vlc", Codes(decision.Viable[0].Notes));
    }

    [Fact]
    public void ImageSubtitle_WithoutVlc_IsBurnedIntoATranscode()
    {
        var decision = Decide(Pgs(), AppleTv(), Prefs(subtitleLanguage: "de", mode: SubtitleMode.Always));

        var chosen = decision.Viable[0];
        Assert.Equal(DeliveryMode.Transcode, chosen.Method);
        Assert.True(chosen.Limits.BurnInSubtitle);
        Assert.Equal(2, chosen.Plan.BurnIn!.Index);
        Assert.Contains("subtitle_burned_in", Codes(chosen.Plan.Reasons));
        Assert.Equal(SubtitlePlan.BurnedIn, chosen.Plan.Subtitles.Single(s => s.Stream.Index == 2).DeliveredAs);
        Assert.False(chosen.Plan.HardwareDecode);
        Assert.Equal((DeliveryMode.Remux, "native"), (decision.Viable[1].Method, decision.Viable[1].Engine.Name));
    }

    [Fact]
    public void ImageSubtitle_WithoutVlcOrTranscoding_PlaysWithoutIt_AndSaysSo()
    {
        var decision = Decide(Pgs(), AppleTv(), Prefs(subtitleLanguage: "de", mode: SubtitleMode.Always), allowTranscoding: false);

        var chosen = decision.Viable[0];
        Assert.Equal(DeliveryMode.Remux, chosen.Method);
        Assert.Null(chosen.Limits.SubtitleStreamIndex);
        var note = Assert.Single(chosen.Notes, n => n.Code == "subtitle_not_deliverable");
        Assert.Equal(("2", "hdmv_pgs_subtitle", "remux"), (note.Params!["index"], note.Params["codec"], note.Params["mode"]));
    }

    [Fact]
    public void ImageSubtitle_ThatTheNativeEngineRenders_PlaysDirect()
    {
        var decision = Decide(Pgs(), AndroidTv(), Prefs(subtitleLanguage: "de", mode: SubtitleMode.Always));

        Assert.Equal((DeliveryMode.Direct, "native"), First(decision));
        Assert.Equal(2, decision.Viable[0].Limits.SubtitleStreamIndex);
    }

    [Fact]
    public void TextSubtitle_ANativeEngineCannotRender_IsDeliveredAsWebVttByARemux()
    {
        var mp4WithSrt = Mp4() with { Subtitles = [Subtitle(2, "subrip", "eng")] };

        var decision = Decide(mp4WithSrt, AppleTv(), Prefs(subtitleLanguage: "en", mode: SubtitleMode.Always));

        Assert.Equal(DeliveryMode.Remux, First(decision).Item1);
        Assert.Contains(decision.Skipped, s => s.Method == DeliveryMode.Direct && Codes(s.Reasons).Contains("subtitle_format_unsupported"));
        Assert.Equal(SubtitlePlan.WebVtt, decision.Viable[0].Plan.Subtitles.Single().DeliveredAs);
    }

    [Fact]
    public void ServerFfmpegUnavailable_LeavesOnlyDirectMethods()
    {
        var disabled = FakePlaybackMedia.Available(enabled: false);

        var failed = Decide(Mkv(), AppleTv(), server: disabled);
        var vlc = Decide(Mkv(), AppleTv(vlc: true), server: disabled);

        Assert.Equal("transcoding_unavailable", failed.Failure!.Code);
        Assert.Equal("transcoding_disabled", failed.Failure.Parameters!["reason"]);
        Assert.Contains(failed.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("transcoding_disabled"));
        Assert.Equal((DeliveryMode.Direct, "vlc"), First(vlc));
    }

    [Fact]
    public void EngineWithoutHls_CannotUseServerRenditions()
    {
        var device = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "android",
            Engines = [Engine("native", ["mp4"], [V("h264")], [A("aac")], null, hls: false)],
        });

        var decision = Decide(Mkv(), device);

        Assert.Equal("no_playable_method", decision.Failure!.Code);
        Assert.Contains(decision.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("hls_unsupported"));
    }

    [Fact]
    public void PerCodecLimits_BlockCopies_AndBoundTheTranscode()
    {
        var device = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "android",
            Engines = [Engine("native", ["mp4", "mkv"], [V("h264", maxHeight: 1080)], [A("aac", max: 2)], null, channels: 2)],
        });
        var uhd = Media(width: 3840, height: 2160, container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 2);
        var surround = Media(container: "mov,mp4,m4a,3gp,3g2,mj2", audioCodec: "aac", channels: 6);

        var big = Decide(uhd, device);
        var channels = Decide(surround, device);

        Assert.Equal(DeliveryMode.Transcode, First(big).Item1);
        Assert.Equal(1080, big.Viable[0].Plan.Video.Height);
        Assert.Contains(big.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("video_size_unsupported"));
        Assert.Equal(DeliveryMode.Remux, First(channels).Item1);
        Assert.Contains(channels.Skipped, s => s.Method == DeliveryMode.Direct && Codes(s.Reasons).Contains("audio_channels_unsupported"));
        Assert.Equal(("aac", 2, false), (channels.Viable[0].Plan.Audio!.Codec, channels.Viable[0].Plan.Audio!.Channels, channels.Viable[0].Plan.Audio!.Copy));
    }

    [Fact]
    public void HdrOnAnSdrBrowser_IsTranscodedWithToneMapping_AndDolbyVisionProfile5TooOnHdrScreens()
    {
        var hdr = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, colorTransfer: "smpte2084", audioCodec: "aac", channels: 2);
        var dv5 = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.DolbyVision, dvProfile: 5, dvCompatibility: 0, audioCodec: "aac", channels: 2);

        var sdr = Decide(hdr, Chrome(hdr: false));
        var hdrScreen = Decide(hdr, Chrome(hdr: true));
        var dolby = Decide(dv5, Chrome(hdr: true));

        Assert.Equal(DeliveryMode.Transcode, First(sdr).Item1);
        Assert.Equal(ToneMapMode.Software, sdr.Viable[0].Plan.ToneMap);
        Assert.Contains(sdr.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("hdr_unsupported"));
        Assert.Equal(DeliveryMode.Remux, First(hdrScreen).Item1);
        Assert.Equal("PQ", hdrScreen.Viable[0].Plan.VideoRange);
        Assert.Equal(DeliveryMode.Transcode, First(dolby).Item1);
        Assert.Contains(dolby.Skipped, s => s.Method == DeliveryMode.Remux && Codes(s.Reasons).Contains("dolby_vision_profile_unsupported"));
    }

    [Fact]
    public void TextSubtitle_OfATranscode_IsDeliveredAsWebVtt()
    {
        var legacy = Media(codec: "mpeg2video", width: 720, height: 576, audioCodec: "ac3", channels: 2, subtitles: [Subtitle(2, "subrip", "eng")]);

        var decision = Decide(legacy, Chrome(), Prefs(subtitleLanguage: "en", mode: SubtitleMode.Always));

        var chosen = decision.Viable[0];
        Assert.Equal(DeliveryMode.Transcode, chosen.Method);
        Assert.Equal(2, chosen.Limits.SubtitleStreamIndex);
        Assert.Equal(SubtitlePlan.WebVtt, chosen.Plan.Subtitles.Single().DeliveredAs);
        Assert.DoesNotContain("subtitle_not_deliverable", Codes(chosen.Notes).Concat(Codes(chosen.Plan.Reasons)));
    }

    [Fact]
    public void Transcodes_DefaultTo1080p_UnlessTheViewerAsksForMore()
    {
        var uhdHdr = Media(codec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: HdrFormat.Hdr10, colorTransfer: "smpte2084", audioCodec: "aac", channels: 2);

        var fallback = Decide(uhdHdr, Chrome());
        var asked = Decide(uhdHdr, Chrome(), Prefs(maxHeight: 2160));

        Assert.Equal(DeliveryMode.Transcode, First(fallback).Item1);
        Assert.Equal(1080, fallback.Viable[0].Limits.MaxHeight);
        Assert.Equal(1080, fallback.Viable[0].Plan.Video.Height);
        var note = Assert.Single(fallback.Viable[0].Notes, n => n.Code == "transcode_height_default");
        Assert.Equal(("2160", "1080"), (note.Params!["height"], note.Params["max"]));
        Assert.Equal(2160, asked.Viable[0].Plan.Video.Height);
        Assert.DoesNotContain("transcode_height_default", Codes(asked.Viable[0].Notes));
    }

    [Fact]
    public void VlcThatToneMaps_PlaysHdrDirect_OnAnSdrDisplay()
    {
        var hdr = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, colorTransfer: "smpte2084", audioCodec: "eac3", channels: 6);
        DeviceCaps Tv(bool toneMapping) => DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "androidtv",
            VlcAvailable = true,
            Engines =
            [
                Engine("native", ["mp4", "mkv"], [V("h264"), V("hevc", 10)], [A("aac"), A("eac3")], ["srt"]),
                Engine("vlc", ["mkv", "mp4"], [V("h264"), V("hevc", 10)], [A("aac"), A("eac3")], ["srt", "pgs"]) with { HdrToneMapping = toneMapping },
            ],
        });

        var toneMapped = Decide(hdr, Tv(toneMapping: true), Prefs(EnginePreference.Vlc));
        var auto = Decide(hdr, Tv(toneMapping: true));

        Assert.Equal((DeliveryMode.Direct, "vlc"), First(toneMapped));
        Assert.Contains("hdr_tone_mapped", Codes(toneMapped.Viable[0].Notes));
        Assert.Equal((DeliveryMode.Direct, "vlc"), First(auto));
        Assert.Contains(auto.Skipped, s => s is { Method: DeliveryMode.Remux, Engine: "native" } && Codes(s.Reasons).Contains("hdr_unsupported"));
    }

    [Fact]
    public void VlcPreference_SendsServerTranscodes_ToTheNativePlayer()
    {
        var hdr = Media(codec: "hevc", bitDepth: 10, hdr: HdrFormat.Hdr10, colorTransfer: "smpte2084", audioCodec: "eac3", channels: 6);
        var device = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "androidtv",
            VlcAvailable = true,
            Engines =
            [
                Engine("native", ["mp4", "mkv"], [V("h264"), V("hevc", 10)], [A("aac"), A("eac3")], ["srt"]),
                Engine("vlc", ["mkv", "mp4"], [V("h264"), V("hevc", 10)], [A("aac"), A("eac3")], ["srt", "pgs"]),
            ],
        });
        var withoutHls = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "androidtv",
            VlcAvailable = true,
            Engines =
            [
                Engine("native", ["mp4"], [V("h264")], [A("aac")], ["srt"], hls: false),
                Engine("vlc", ["mkv", "mp4"], [V("h264"), V("hevc", 10)], [A("aac"), A("eac3")], ["srt", "pgs"]),
            ],
        });

        var decision = Decide(hdr, device, Prefs(EnginePreference.Vlc));
        var vlcOnly = Decide(hdr, withoutHls, Prefs(EnginePreference.Vlc));

        Assert.Contains(decision.Skipped, s => s is { Method: DeliveryMode.Direct, Engine: "vlc" } && Codes(s.Reasons).Contains("hdr_unsupported"));
        Assert.Equal((DeliveryMode.Transcode, "native"), First(decision));
        Assert.Contains("transcode_native_engine", Codes(decision.Viable[0].Notes));
        Assert.Equal((DeliveryMode.Transcode, "vlc"), First(Decide(hdr, device, Prefs(EnginePreference.Vlc), excluded: new HashSet<string> { "transcode:native" })));
        Assert.Equal((DeliveryMode.Transcode, "vlc"), First(vlcOnly));
    }

    [Fact]
    public void StepDown_ExcludesFailedMethods_UntilNoneIsLeft()
    {
        var device = AppleTv(vlc: true);

        var next = Decide(Mkv(), device, excluded: new HashSet<string> { "remux:native" });
        var none = Decide(Mkv(), device, excluded: new HashSet<string> { "remux:native", "direct:vlc", "transcode:native" });

        Assert.Equal((DeliveryMode.Direct, "vlc"), First(next));
        Assert.Contains(next.Skipped, s => Codes(s.Reasons).Contains("step_down"));
        Assert.Equal("no_more_methods", none.Failure!.Code);
    }

    [Fact]
    public void AudioLanguage_PicksTheMatchingTrack_PreferringTheDefault_ElseSaysItIsMissing()
    {
        var media = Mkv() with
        {
            Audio =
            [
                new SourceAudioStream { Index = 1, Codec = "ac3", Channels = 6, Language = "ger", IsDefault = true },
                new SourceAudioStream { Index = 2, Codec = "ac3", Channels = 2, Language = "eng" },
                new SourceAudioStream { Index = 3, Codec = "aac", Channels = 2, Language = "eng", Title = "Commentary" },
            ],
        };

        var english = TrackSelector.Select(media, null, null, Prefs(audioLanguage: "en"));
        var german = TrackSelector.Select(media, null, null, Prefs(audioLanguage: "de"));
        var french = TrackSelector.Select(media, null, null, Prefs(audioLanguage: "fr"));
        var requested = TrackSelector.Select(media, 3, null, Prefs(audioLanguage: "de"));

        Assert.Equal(2, english.Audio!.Index);
        Assert.Equal(1, german.Audio!.Index);
        Assert.Equal(1, french.Audio!.Index);
        Assert.Contains("audio_language_unavailable", Codes(french.Notes));
        Assert.Equal(3, requested.Audio!.Index);
        Assert.Contains("audio_track_requested", Codes(requested.Notes));
    }

    [Fact]
    public void SubtitleModes_OffForcedAndAlways_PickTheRightTrack()
    {
        var media = Mkv(Subtitle(3, "ass", "ger"), Subtitle(4, "ass", "eng"), Subtitle(5, "subrip", "ger", forced: true), Subtitle(6, "subrip", "eng", forced: true))
            with
            {
                Audio = [new SourceAudioStream { Index = 1, Codec = "ac3", Channels = 6, Language = "ger", IsDefault = true }],
            };

        Assert.Null(TrackSelector.Select(media, null, null, Prefs(mode: SubtitleMode.Off)).Subtitle);
        Assert.Equal(5, TrackSelector.Select(media, null, null, Prefs(mode: SubtitleMode.Forced)).Subtitle!.Index);
        Assert.Equal(4, TrackSelector.Select(media, null, null, Prefs(mode: SubtitleMode.Always, subtitleLanguage: "en")).Subtitle!.Index);
        Assert.Equal(3, TrackSelector.Select(media, null, null, Prefs(mode: SubtitleMode.Always)).Subtitle!.Index);
        var missing = TrackSelector.Select(media, null, null, Prefs(mode: SubtitleMode.Always, subtitleLanguage: "fr"));
        Assert.Null(missing.Subtitle);
        Assert.Contains("subtitle_language_unavailable", Codes(missing.Notes));
        Assert.Null(TrackSelector.Select(media, null, -1, Prefs(mode: SubtitleMode.Always, subtitleLanguage: "en")).Subtitle);
        Assert.Equal(6, TrackSelector.Select(media, null, 6, Prefs(mode: SubtitleMode.Off)).Subtitle!.Index);
    }

    [Fact]
    public void UnknownTrackIndexes_AreStableFailures()
    {
        var audio = Assert.Throws<PlaybackFailure>(() => TrackSelector.Select(Mkv(), 9, null, Prefs()));
        var subtitle = Assert.Throws<PlaybackFailure>(() => TrackSelector.Select(Mkv(), null, 9, Prefs()));

        Assert.Equal(("unknown_audio_stream", "9"), (audio.Code, audio.Parameters!["index"]));
        Assert.Equal("unknown_subtitle_stream", subtitle.Code);
    }

    [Fact]
    public void DeviceProfiles_UseCanonicalNames_AndVlcNeedsVlcAvailable()
    {
        var device = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "androidtv",
            VlcAvailable = true,
            Engines = [Engine("native", ["matroska", "MOV"], [V("H265", 10, null, "HDR10", "dv"), V("avc")], [A("EC-3", true), A("dca")], ["subrip", "PGSSUB"])],
        });
        var noVlc = DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = "android",
            VlcAvailable = false,
            Engines = [Engine("native", ["mp4"], [V("h264")], [A("aac")], null), Engine("vlc", ["mkv"], [V("h264")], [A("aac")], null)],
        });

        var native = device.Native!;
        Assert.Equal(["mkv", "mp4"], native.Containers);
        Assert.Equal(["hevc", "h264"], native.Video.Select(v => v.Codec));
        Assert.Equal(["hdr10", "dolbyvision"], native.Video[0].HdrFormats);
        Assert.Equal(8, native.Video[1].MaxBitDepth);
        Assert.Equal(["eac3", "dts"], native.Audio.Select(a => a.Codec));
        Assert.Equal(["srt", "pgs"], native.SubtitleFormats);
        Assert.True(native.RendersSubtitle("hdmv_pgs_subtitle"));
        Assert.Same(EngineCaps.DefaultVlc, device.Vlc);
        Assert.Null(noVlc.Vlc);
        var client = native.ClientFor(Media(codec: "hevc", bitDepth: 10).Video);
        Assert.True(client.Supports10Bit);
        Assert.Equal(["hdr10", "dolbyvision"], client.HdrFormats);
    }

    [Theory]
    [InlineData(null, "native")]
    [InlineData("tv", "native")]
    [InlineData("web", "mpv")]
    public void InvalidDeviceProfiles_AreRejected(string? platform, string engine)
    {
        var problem = Assert.Throws<ViewerProblem>(() => DeviceCaps.Parse(new DeviceProfileDto
        {
            Platform = platform,
            Engines = [new EngineProfileDto { Engine = engine }],
        }));

        Assert.Equal(("invalid_device_profile", 400), (problem.Code, problem.Status));
    }

    [Fact]
    public void Preferences_MergeSetFieldsOverTheCurrentOnes()
    {
        var current = PlaybackPreferences.Merge(new PlaybackPreferencesDto { Engine = "vlc", MaxHeight = 720, AudioLanguage = "de-DE", SubtitleMode = "always" }, PlaybackPreferences.Default);
        var merged = PlaybackPreferences.Merge(new PlaybackPreferencesDto { MaxBitrateKbps = 4_000, SubtitleLanguage = "eng" }, current);

        Assert.Equal(new PlaybackPreferences(EnginePreference.Vlc, 720, 4_000, "de", "en", SubtitleMode.Always), merged);
        Assert.Equal(SubtitleMode.Forced, PlaybackPreferences.Default.SubtitleMode);
    }
}
