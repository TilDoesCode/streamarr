using System.Globalization;
using Streamarr.Server.Transcoding;
using static Streamarr.Server.Tests.Transcoding.TranscodeTestData;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class TranscodingParsingTests
{
    [Fact]
    public void Ffprobe_Hdr10Uhd_IsRecognisedWithDepthRateAndDefaultAudio()
    {
        var media = SourceMediaProber.Parse("""
        {
          "format": { "format_name": "matroska,webm", "duration": "7201.5", "bit_rate": "24000000" },
          "streams": [
            { "index": 0, "codec_type": "video", "codec_name": "hevc", "profile": "Main 10", "width": 3840, "height": 2160,
              "pix_fmt": "yuv420p10le", "avg_frame_rate": "24000/1001", "color_transfer": "smpte2084", "color_primaries": "bt2020",
              "field_order": "progressive" },
            { "index": 1, "codec_type": "audio", "codec_name": "truehd", "channels": 8, "sample_rate": "48000",
              "tags": { "language": "eng", "title": "Atmos" } },
            { "index": 2, "codec_type": "audio", "codec_name": "ac3", "channels": 6, "disposition": { "default": 1 },
              "tags": { "language": "ger" } },
            { "index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle" },
            { "index": 4, "codec_type": "video", "codec_name": "mjpeg", "disposition": { "attached_pic": 1 } }
          ]
        }
        """);

        Assert.Equal(7201.5, media.DurationSeconds);
        Assert.Equal(24_000_000, media.BitRate);
        var video = Assert.IsType<SourceVideoStream>(media.Video);
        Assert.Equal(("hevc", 3840, 2160, 10), (video.Codec, video.Width, video.Height, video.BitDepth));
        Assert.Equal(HdrFormat.Hdr10, video.Hdr);
        Assert.False(video.Interlaced);
        Assert.Equal(23.976, video.FrameRate!.Value, 3);
        Assert.Equal(2, media.Audio.Count);
        Assert.Equal("Atmos", media.Audio[0].Title);
        Assert.True(media.Audio[1].IsDefault);
        Assert.Equal(1, media.SubtitleCount);
        Assert.Equal(2, TranscodePlanner.SelectAudio(media, null)!.Index);
    }

    [Fact]
    public void Ffprobe_DolbyVisionHlgAndInterlacedFlags_AreDetected()
    {
        var dolby = SourceMediaProber.Parse("""
        { "format": { "duration": "60" }, "streams": [ { "index": 0, "codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 2160,
          "pix_fmt": "yuv420p10le", "color_transfer": "smpte2084", "side_data_list": [ { "side_data_type": "DOVI configuration record" } ] } ] }
        """);
        var hlg = SourceMediaProber.Parse("""
        { "format": { "duration": "60" }, "streams": [ { "index": 0, "codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080,
          "pix_fmt": "yuv420p10le", "color_transfer": "arib-std-b67" } ] }
        """);
        var interlaced = SourceMediaProber.Parse("""
        { "format": { "duration": "60" }, "streams": [ { "index": 0, "codec_type": "video", "codec_name": "mpeg2video", "width": 720, "height": 576,
          "pix_fmt": "yuv420p", "field_order": "tb", "r_frame_rate": "25/1", "avg_frame_rate": "0/0" } ] }
        """);

        Assert.Equal(HdrFormat.DolbyVision, dolby.Video!.Hdr);
        Assert.Equal(HdrFormat.Hlg, hlg.Video!.Hdr);
        Assert.True(interlaced.Video!.Interlaced);
        Assert.Equal(25, interlaced.Video.FrameRate);
    }

    [Fact]
    public void Ffprobe_MissingFormatDuration_FallsBackToTheLongestStream()
    {
        var media = SourceMediaProber.Parse("""
        { "format": { "format_name": "mpegts" }, "streams": [
          { "index": 0, "codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720, "duration": "99.5" },
          { "index": 1, "codec_type": "audio", "codec_name": "aac", "duration": "100.25" } ] }
        """);

        Assert.Equal(100.25, media.DurationSeconds);
    }

    [Theory]
    [InlineData("yuv420p", 8)]
    [InlineData("yuv420p10le", 10)]
    [InlineData("p010le", 10)]
    [InlineData("yuv444p12le", 12)]
    [InlineData(null, 8)]
    public void BitDepth_IsDerivedFromThePixelFormat(string? format, int depth)
        => Assert.Equal(depth, SourceMediaProber.BitDepthOf(format));

    [Theory]
    [InlineData("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", "6.1.1-3ubuntu5", 6)]
    [InlineData("ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers", "8.0.1", 8)]
    [InlineData("ffmpeg version n7.1.1-Jellyfin Copyright", "n7.1.1-Jellyfin", 7)]
    [InlineData("ffmpeg version N-117654-g1234abcd Copyright", "N-117654-g1234abcd", null)]
    public void FfmpegVersion_IsParsedIncludingDistroAndGitBuilds(string banner, string version, int? major)
        => Assert.Equal((version, major), FfmpegCapabilityProbe.ParseVersion(banner));

    [Fact]
    public void EncoderAndFilterLists_AreParsedForBothOutputGenerations()
    {
        var encoders = FfmpegCapabilityProbe.ParseCodecList("""
        Encoders:
         V..... = Video
         A..... = Audio
         ------
         V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
         V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
         A....D aac                  AAC (Advanced Audio Coding)
        """);
        var filtersV6 = FfmpegCapabilityProbe.ParseFilters("""
        Filters:
          T.. = Timeline support
          ..C = Command support
         TS. bwdif             V->V       Deinterlace the input image.
         .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.
         ... scale_vaapi       V->V       Scale to/from VAAPI surfaces.
        """);
        var filtersV8 = FfmpegCapabilityProbe.ParseFilters("""
        Filters:
          T.. = Timeline support
         TS bwdif             V->V       Deinterlace the input image.
         .. scale_vt          V->V       Scale Videotoolbox frames
         .S tonemap           V->V       Conversion to/from different dynamic ranges.
        """);

        Assert.Equal(new HashSet<string> { "libx264", "h264_vaapi", "aac" }, encoders);
        Assert.Equal(new HashSet<string> { "bwdif", "zscale", "scale_vaapi" }, filtersV6);
        Assert.Equal(new HashSet<string> { "bwdif", "scale_vt", "tonemap" }, filtersV8);
        Assert.Equal(new HashSet<string> { "vaapi", "cuda" },
            FfmpegCapabilityProbe.ParseHwAccels("Hardware acceleration methods:\nvaapi\ncuda\n\n"));
    }

    [Theory]
    [InlineData("[h264 @ 0x1] Failed setup for format vaapi: hwaccel initialisation returned error.", true)]
    [InlineData("[av1 @ 0x2] Your platform doesn't support hardware accelerated AV1 decoding.\nhwaccel initialisation returned error", true)]
    [InlineData("frame=  24 fps=0.0 q=-0.0 Lsize=N/A time=00:00:01.00", false)]
    public void SilentSoftwareFallback_IsDetectedFromStderr(string stderr, bool fallback)
        => Assert.Equal(fallback, FfmpegCapabilityProbe.HasHardwareFailure(stderr));

    [Fact]
    public void SegmentTimeline_FollowsFfmpegsCutsIncludingTheTail()
    {
        var exact = SegmentTimeline.Create(30, 4);
        var tinyTail = SegmentTimeline.Create(28.3, 4);
        var shortClip = SegmentTimeline.Create(0.3, 4);

        Assert.Equal(8, exact.Count);
        Assert.Equal(2, exact.Durations[^1]);
        Assert.Equal(28, exact.StartOf(7));
        Assert.Equal(7, tinyTail.Count);
        Assert.All(tinyTail.Durations, d => Assert.Equal(4, d));
        Assert.Equal([0.3], shortClip.Durations);
    }

    [Fact]
    public void Playlists_AreSpecCompliantVodFmp4()
    {
        var plan = Plan(limits: new TranscodeLimits(MaxHeight: 720));
        var media = HlsPlaylist.Media(SegmentTimeline.Create(30, 4));
        var master = HlsPlaylist.Master(plan);

        Assert.StartsWith("#EXTM3U\n#EXT-X-VERSION:7\n", media);
        Assert.Contains("#EXT-X-TARGETDURATION:4\n", media);
        Assert.Contains("#EXT-X-PLAYLIST-TYPE:VOD\n", media);
        Assert.Contains("#EXT-X-MAP:URI=\"init.mp4\"\n", media);
        Assert.Contains("#EXTINF:2.000000,\n7.m4s\n", media);
        Assert.EndsWith("#EXT-X-ENDLIST\n", media);
        Assert.Contains("CODECS=\"avc1.640029,mp4a.40.2\"", master);
        Assert.Contains("RESOLUTION=1280x720", master);
        Assert.Contains($"BANDWIDTH={plan.BandwidthBitsPerSecond},", master);
        Assert.EndsWith("main.m3u8\n", master);
    }

    [Fact]
    public void Settings_ValidateEveryBound()
    {
        Assert.Empty(new TranscodingSettings().Validate());
        Assert.Empty(new TranscodingSettings { VaapiDevice = "/dev/dri/card1", HardwareDecodingCodecs = ["h264", "hevc10"] }.Validate());

        Assert.Contains(new TranscodingSettings { Crf = 99 }.Validate(), e => e.Contains("crf"));
        Assert.Contains(new TranscodingSettings { VaapiDevice = "/etc/passwd" }.Validate(), e => e.Contains("vaapiDevice"));
        Assert.Contains(new TranscodingSettings { VaapiDevice = "/dev/dri/renderD128;rm -rf /" }.Validate(), e => e.Contains("vaapiDevice"));
        Assert.Contains(new TranscodingSettings { EncoderPreset = "placebo" }.Validate(), e => e.Contains("encoderPreset"));
        Assert.Contains(new TranscodingSettings { HardwareDecodingCodecs = ["prores"] }.Validate(), e => e.Contains("hardwareDecodingCodecs"));
        Assert.Contains(new TranscodingSettings { SegmentLengthSeconds = 1 }.Validate(), e => e.Contains("segmentLengthSeconds"));
        Assert.Contains(new TranscodingSettings { MaxConcurrentTranscodes = 0 }.Validate(), e => e.Contains("maxConcurrentTranscodes"));
    }

    [Fact]
    public void ConfigWrite_IsAPartialUpdate()
    {
        var current = new TranscodingSettings { Crf = 20, HardwareDecodingCodecs = ["h264"] };

        var accel = TranscodingResponses.Apply(current, new TranscodingConfigWrite { Acceleration = "cuda" }, out var error);
        var auto = TranscodingResponses.Apply(current, new TranscodingConfigWrite { HardwareDecodingAuto = true }, out _);
        TranscodingResponses.Apply(current, new TranscodingConfigWrite { Acceleration = "quantum" }, out var invalid);

        Assert.Null(error);
        Assert.Equal((HardwareAcceleration.Nvenc, 20), (accel.Acceleration, accel.Crf));
        Assert.Equal(["h264"], accel.HardwareDecodingCodecs);
        Assert.Null(auto.HardwareDecodingCodecs);
        Assert.NotNull(invalid);
    }

    [Fact]
    public void BenchmarkGrade_IsWorded_IndependentOfTheServerCulture()
    {
        var previous = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
        var directory = Directory.CreateTempSubdirectory("streamarr-grade-").FullName;
        try
        {
            var plan = Plan(Media(duration: 30));
            var run = new FfmpegRunResult(0, false, TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(3), 719, 30, string.Empty);

            var result = TranscodingBenchmarkService.Grade(plan, SegmentTimeline.Create(30, 4), run, 400, 380, directory, [], 0);

            Assert.Equal("excellent", result.Verdict);
            Assert.StartsWith("15.0× realtime", result.Summary);
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Redaction_HidesStreamAndTranscodeCapabilities()
    {
        var redacted = TranscodeRedaction.Redact(
            "Opening 'http://127.0.0.1:8080/api/v1/stream/0a1b2c3d4e' and /api/v1/transcode/AbC_-123/5.m4s");

        Assert.DoesNotContain("0a1b2c3d4e", redacted);
        Assert.DoesNotContain("AbC_-123", redacted);
        Assert.Contains("/api/v1/stream/{capability}", redacted);
    }
}
