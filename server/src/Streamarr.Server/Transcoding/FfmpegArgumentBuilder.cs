using System.Globalization;

namespace Streamarr.Server.Transcoding;

public sealed record FfmpegJobSpec
{
    public required TranscodePlan Plan { get; init; }
    public required TranscodeSource Source { get; init; }
    public required TranscodingSettings Settings { get; init; }
    public required FfmpegCapabilities Capabilities { get; init; }
    public required string OutputDirectory { get; init; }
    public required string JobTag { get; init; }
    public double SegmentLength { get; init; } = 4;
    public int StartSegment { get; init; }
    public double? MaxInputSeconds { get; init; }

    /// <summary>Input seek of a remux run: just past the start segment's keyframe (see <see cref="FfmpegArgumentBuilder.RemuxSeekSeconds"/>).</summary>
    public double? SeekSeconds { get; init; }

    /// <summary>Where the source audio starts on the output timeline and its sample rate; converted audio of a restart keeps the frame grid of the run from 0.</summary>
    public double AudioStartSeconds { get; init; }
    public int? SourceAudioSampleRate { get; init; }

    public string InitFileName => $"init-{JobTag}.mp4";
    public string PlaylistFileName => $"job-{JobTag}.m3u8";
    public double StartSeconds => StartSegment * SegmentLength;
}

/// <summary>Builds the ffmpeg command line for one HLS transcode run; pure and fully unit-tested.</summary>
public static class FfmpegArgumentBuilder
{
    public const string UserAgent = "Streamarr-Transcoder/1";

    public const string SoftwareToneMapChain =
        "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

    public const string RemuxMovFlags = "+frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont+skip_trailer";

    public static IReadOnlyList<string> Build(FfmpegJobSpec spec)
    {
        if (spec.Plan.Mode == DeliveryMode.Remux)
            return BuildRemux(spec);
        var plan = spec.Plan;
        var args = new List<string>
        {
            "-hide_banner", "-nostdin",
            "-loglevel", "level+warning",
            "-progress", "pipe:1",
        };

        if (plan.HardwareDecode || plan.HardwareEncode)
            args.AddRange(HardwareProfiles.InitArgs(plan.Acceleration, spec.Settings.VaapiDevice, spec.Settings.NvencDevice));

        if (spec.Source.IsNetwork)
        {
            args.AddRange([
                "-user_agent", UserAgent,
                "-reconnect", "1",
                "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "10",
            ]);
        }
        args.AddRange(["-analyzeduration", "5000000", "-probesize", "10000000"]);
        if (spec.StartSegment > 0)
            args.AddRange(["-ss", Seconds(spec.StartSeconds)]);
        if (spec.MaxInputSeconds is { } limit)
            args.AddRange(["-t", Seconds(limit)]);
        if (plan.HardwareDecode)
            args.AddRange(HardwareProfiles.DecodeArgs(plan.Acceleration));
        args.AddRange(["-i", spec.Source.Input]);
        if (spec.Settings.Threads > 0)
            args.AddRange(["-threads", spec.Settings.Threads.ToString(CultureInfo.InvariantCulture)]);

        if (plan.BurnIn is not null)
            args.AddRange(["-filter_complex", BuildBurnInGraph(plan), "-map", "[vout]"]);
        else
            args.AddRange(["-map", $"0:{plan.SourceVideo.Index}"]);
        if (plan.Audio is { } audio)
            args.AddRange(["-map", $"0:{audio.SourceIndex}"]);
        args.AddRange(["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"]);

        AddVideo(args, spec);
        AddAudio(args, spec);

        args.AddRange([
            "-copyts", "-start_at_zero",
            "-avoid_negative_ts", "make_non_negative",
            "-max_muxing_queue_size", "2048",
            "-max_delay", "5000000",
            "-f", "hls",
            "-hls_time", Seconds(spec.SegmentLength),
            "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", spec.InitFileName,
            "-start_number", spec.StartSegment.ToString(CultureInfo.InvariantCulture),
            "-hls_segment_filename", Path.Combine(spec.OutputDirectory, "%d.m4s"),
            "-hls_playlist_type", "vod",
            "-hls_list_size", "0",
            "-hls_flags", "temp_file",
            "-hls_segment_options", "movflags=+frag_discont",
            "-y", Path.Combine(spec.OutputDirectory, spec.PlaylistFileName),
        ]);
        return args;
    }

    /// <summary>Stream copy into fMP4 on stdout for the <see cref="RemuxSegmenter"/> (source timestamps kept), plus one WebVTT file per text subtitle.</summary>
    public static IReadOnlyList<string> BuildRemux(FfmpegJobSpec spec)
    {
        var plan = spec.Plan;
        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "level+warning" };
        if (spec.Source.IsNetwork)
        {
            args.AddRange([
                "-user_agent", UserAgent,
                "-reconnect", "1",
                "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "10",
            ]);
        }
        args.AddRange(["-analyzeduration", "5000000", "-probesize", "10000000"]);
        if (spec.SeekSeconds is { } seek && seek > 0)
            args.AddRange(["-ss", Micros(seek)]);
        if (spec.MaxInputSeconds is { } limit)
            args.AddRange(["-t", Seconds(limit)]);
        args.AddRange(["-i", spec.Source.Input]);

        args.AddRange(["-map", $"0:{plan.SourceVideo.Index}"]);
        if (plan.Audio is { } audio)
            args.AddRange(["-map", $"0:{audio.SourceIndex}"]);
        args.AddRange(["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-c:v", "copy"]);
        if (plan.SourceVideo.Codec == "hevc")
            args.AddRange(["-tag:v", "hvc1"]);
        if (plan.Audio is { Copy: true })
        {
            args.AddRange(["-c:a", "copy"]);
        }
        else if (plan.Audio is { } converted)
        {
            args.AddRange([
                "-c:a", converted.Codec,
                "-ac", converted.Channels.ToString(CultureInfo.InvariantCulture),
                "-b:a", Kbps(converted.BitrateKbps),
            ]);
            if (converted.SampleRate is { } rate)
                args.AddRange(["-ar", rate.ToString(CultureInfo.InvariantCulture)]);
            var sampleRate = converted.SampleRate ?? spec.SourceAudioSampleRate ?? 48_000;
            args.AddRange(["-af", $"atrim=start={Micros(RemuxAudioTrimSeconds(spec.SeekSeconds, converted, sampleRate, spec.AudioStartSeconds))}"]);
        }
        else
        {
            args.Add("-an");
        }
        args.AddRange([
            "-copyts", "-start_at_zero",
            "-avoid_negative_ts", "disabled",
            "-max_muxing_queue_size", "4096",
            "-f", "mp4",
            "-movflags", RemuxMovFlags,
            "pipe:1",
        ]);

        foreach (var subtitle in plan.Subtitles.Where(s => s.Delivered))
        {
            args.AddRange([
                "-map", $"0:{subtitle.Stream.Index}",
                "-c:s", "webvtt",
                "-avoid_negative_ts", "disabled",
                "-flush_packets", "1",
                "-f", "webvtt",
                "-y", Path.Combine(spec.OutputDirectory, new SubtitleTrackStore(subtitle.Stream.Index).FileName(spec.JobTag)),
            ]);
        }
        return args;
    }

    /// <summary>Encoder priming would give the run from 0 a negative first timestamp, so that run trims this much input audio instead.</summary>
    internal static double EncoderPrimingSeconds(AudioTarget audio)
        => audio.Codec == "aac" ? 1024d / 16_000 + 0.001 : 256d / 32_000 + 0.001;

    /// <summary>The run from 0 trims the encoder priming; a restart starts its audio on that run's encoder frame grid, so segments of different runs meet sample-exactly.</summary>
    internal static double RemuxAudioTrimSeconds(double? seek, AudioTarget audio, int sampleRate, double audioStart)
    {
        var priming = EncoderPrimingSeconds(audio);
        if (seek is not { } exact || exact <= 0)
            return priming;
        var from = Math.Round(exact, 6);
        var origin = Math.Max(priming, audioStart);
        var frame = (audio.Codec == "aac" ? 1024d : 1536d) / Math.Max(8_000, sampleRate);
        return from <= origin ? origin : origin + Math.Ceiling((from - origin) / frame - 1e-9) * frame;
    }

    /// <summary>Seek target that lands on <paramref name="keyframe"/> both with ffmpeg's Matroska "dts heuristic" (−3/23 s) and with SEEK_TO_PTS demuxers.</summary>
    public static double RemuxSeekSeconds(double keyframe, double? nextKeyframe)
    {
        const double DtsHeuristic = 3d / 23d;
        var gap = nextKeyframe is { } next && next > keyframe ? next - keyframe : 10;
        return gap > DtsHeuristic + 0.04
            ? keyframe + DtsHeuristic + Math.Min(0.02, (gap - DtsHeuristic) / 2)
            : keyframe + gap / 2;
    }

    private static void AddVideo(List<string> args, FfmpegJobSpec spec)
    {
        var plan = spec.Plan;
        var target = plan.Video;
        var bitrate = target.BitrateKbps;
        var gop = GopFrames(spec.SegmentLength, target.FrameRate).ToString(CultureInfo.InvariantCulture);
        args.AddRange(["-c:v", plan.Encoder]);

        switch (plan.Encoder)
        {
            case "libx264":
                args.AddRange([
                    "-preset", spec.Settings.EncoderPreset,
                    "-crf", spec.Settings.Crf.ToString(CultureInfo.InvariantCulture),
                    "-maxrate", Kbps(bitrate), "-bufsize", Kbps(bitrate * 2),
                    "-profile:v", "high", "-level:v", target.Level,
                    "-sc_threshold:v", "0",
                ]);
                break;
            case "libx265":
                args.AddRange([
                    "-preset", spec.Settings.EncoderPreset,
                    "-crf", (spec.Settings.Crf + 5).ToString(CultureInfo.InvariantCulture),
                    "-maxrate", Kbps(bitrate), "-bufsize", Kbps(bitrate * 2),
                    "-profile:v", "main", "-tag:v", "hvc1",
                    "-x265-params", "no-scenecut=1:no-open-gop=1:no-info=1:log-level=error",
                ]);
                break;
            case "h264_videotoolbox" or "hevc_videotoolbox":
                args.AddRange(["-prio_speed", "1", "-b:v", Kbps(bitrate), "-qmin", "-1", "-qmax", "-1", "-g:v", gop]);
                args.AddRange(target.Codec == "hevc" ? ["-profile:v", "main", "-tag:v", "hvc1"] : ["-profile:v", "high"]);
                break;
            case "h264_vaapi" or "hevc_vaapi":
                args.AddRange(["-rc_mode", "VBR", "-b:v", Kbps(bitrate), "-maxrate", Kbps(bitrate), "-bufsize", Kbps(bitrate * 2)]);
                args.AddRange(target.Codec == "hevc" ? ["-profile:v", "main", "-tag:v", "hvc1"] : ["-profile:v", "high"]);
                break;
            case "h264_qsv" or "hevc_qsv":
                args.AddRange([
                    "-preset", QsvPreset(spec.Settings.EncoderPreset),
                    "-b:v", Kbps(bitrate), "-maxrate", Kbps(bitrate + 1), "-bufsize", Kbps(bitrate * 4),
                    "-rc_init_occupancy", Kbps(bitrate * 2), "-mbbrc", "1", "-look_ahead", "0", "-async_depth", "1",
                    "-forced_idr", "1", "-g:v", gop, "-keyint_min:v", gop,
                ]);
                args.AddRange(target.Codec == "hevc" ? ["-profile:v", "main", "-tag:v", "hvc1"] : ["-profile:v", "high"]);
                break;
            case "h264_nvenc" or "hevc_nvenc":
                args.AddRange([
                    "-preset", NvencPreset(spec.Settings.EncoderPreset),
                    "-b:v", Kbps(bitrate), "-maxrate", Kbps(bitrate), "-bufsize", Kbps(bitrate * 2),
                    "-forced-idr", "1", "-g:v", gop, "-keyint_min:v", gop,
                    .. HardwareProfiles.EncoderDeviceArgs(HardwareAcceleration.Nvenc, spec.Settings.NvencDevice),
                ]);
                args.AddRange(target.Codec == "hevc" ? ["-profile:v", "main", "-tag:v", "hvc1"] : ["-profile:v", "high"]);
                break;
        }

        args.AddRange(["-force_key_frames:v", KeyframeExpression(spec)]);
        var filters = plan.BurnIn is null ? BuildVideoFilters(plan) : string.Empty;
        if (filters.Length > 0)
            args.AddRange(["-vf", filters]);
    }

    /// <summary>Software graph for a burn-in: deinterlace and tone-map the source, overlay the image subtitle at source size, then scale and hand off to the encoder.</summary>
    public static string BuildBurnInGraph(TranscodePlan plan)
    {
        var subtitle = plan.BurnIn ?? throw new InvalidOperationException("The plan burns in no subtitle.");
        var before = new List<string>();
        if (plan.Deinterlace)
            before.Add("bwdif=mode=send_frame:parity=auto:deint=all");
        if (plan.ToneMap == ToneMapMode.Software)
            before.Add(SoftwareToneMapChain);
        var after = new List<string>();
        if (plan.Scales)
            after.Add($"scale=w={plan.Video.Width}:h={plan.Video.Height}");
        after.Add(plan.HardwareEncode ? HardwareProfiles.UploadFilter(plan.Acceleration) : "format=yuv420p");
        var pre = before.Count == 0 ? "null" : string.Join(',', before);
        return $"[0:{plan.SourceVideo.Index}]{pre}[base];[base][0:{subtitle.Index}]overlay=eof_action=pass:repeatlast=0[burned];[burned]{string.Join(',', after)}[vout]";
    }

    private static void AddAudio(List<string> args, FfmpegJobSpec spec)
    {
        var audio = spec.Plan.Audio;
        if (audio is null)
        {
            args.Add("-an");
            return;
        }
        if (audio.Copy)
        {
            args.AddRange(["-c:a", "copy"]);
            // An input seek does not trim copied audio (Matroska even seeks back to a subtitle cue), so drop what precedes the restart point.
            if (spec.StartSegment > 0 && spec.Capabilities.MajorVersion is null or >= 6)
                args.AddRange(["-bsf:a", $"noise=drop=lt(pts*tb\\,{Seconds(spec.StartSeconds)})"]);
            return;
        }
        args.AddRange([
            "-c:a", "aac",
            "-ac", audio.Channels.ToString(CultureInfo.InvariantCulture),
            "-b:a", Kbps(audio.BitrateKbps),
        ]);
        if (audio.SampleRate is { } rate)
            args.AddRange(["-ar", rate.ToString(CultureInfo.InvariantCulture)]);
    }

    /// <summary>Keyframes on the absolute segment grid; ffmpeg ≥ 6 measures <c>t</c> from the first frame, older builds from the source clock.</summary>
    internal static string KeyframeExpression(FfmpegJobSpec spec)
    {
        var length = Seconds(spec.SegmentLength);
        return spec.Capabilities.RelativeKeyframeExpressions || spec.StartSegment == 0
            ? $"expr:gte(t,n_forced*{length})"
            : $"expr:gte(t,{Seconds(spec.StartSeconds)}+n_forced*{length})";
    }

    public static string BuildVideoFilters(TranscodePlan plan)
    {
        var w = plan.Video.Width;
        var h = plan.Video.Height;
        var tenBit = plan.SourceVideo.BitDepth > 8;
        var filters = new List<string>();
        var inHardware = false;

        if (plan.HardwareDecode)
        {
            inHardware = true;
            switch (plan.Acceleration)
            {
                case HardwareAcceleration.VideoToolbox:
                    filters.Add(plan.ToneMap == ToneMapMode.Hardware
                        ? $"scale_vt=w={w}:h={h}:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709"
                        : $"scale_vt=w={w}:h={h}");
                    if (plan.ToneMap == ToneMapMode.Software)
                    {
                        filters.AddRange(["hwdownload", tenBit ? "format=p010le" : "format=nv12"]);
                        inHardware = false;
                    }
                    break;
                case HardwareAcceleration.Vaapi or HardwareAcceleration.Qsv:
                    if (plan.ToneMap == ToneMapMode.Hardware)
                    {
                        filters.Add($"scale_vaapi=w={w}:h={h}:format=p010");
                        filters.Add("tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709");
                    }
                    else if (plan.ToneMap == ToneMapMode.Software)
                    {
                        filters.AddRange([$"scale_vaapi=w={w}:h={h}:format=p010", "hwdownload", "format=p010le"]);
                        inHardware = false;
                    }
                    else
                    {
                        filters.Add($"scale_vaapi=w={w}:h={h}:format=nv12");
                    }
                    break;
                case HardwareAcceleration.Nvenc:
                    if (plan.ToneMap == ToneMapMode.Software)
                    {
                        filters.AddRange([$"scale_cuda=w={w}:h={h}", "hwdownload", tenBit ? "format=p010le" : "format=nv12"]);
                        inHardware = false;
                    }
                    else
                    {
                        filters.Add($"scale_cuda=w={w}:h={h}:format=yuv420p");
                    }
                    break;
            }
        }
        else
        {
            if (plan.Deinterlace)
                filters.Add("bwdif=mode=send_frame:parity=auto:deint=all");
            if (plan.Scales)
                filters.Add($"scale=w={w}:h={h}");
        }

        if (!inHardware)
        {
            if (plan.ToneMap == ToneMapMode.Software)
                filters.Add(SoftwareToneMapChain);
            if (plan.HardwareEncode)
                filters.Add(HardwareProfiles.UploadFilter(plan.Acceleration));
            else if (plan.ToneMap != ToneMapMode.Software)
                filters.Add("format=yuv420p");
        }
        else if (!plan.HardwareEncode)
        {
            var downloaded = plan.Acceleration switch
            {
                HardwareAcceleration.VideoToolbox => tenBit ? "p010le" : "nv12",
                HardwareAcceleration.Nvenc => "yuv420p",
                _ => "nv12",
            };
            filters.AddRange(["hwdownload", $"format={downloaded}"]);
            if (downloaded != "yuv420p")
                filters.Add("format=yuv420p");
        }
        else if (plan.Acceleration == HardwareAcceleration.Qsv)
        {
            filters.Add("hwmap=derive_device=qsv,format=qsv");
        }

        return string.Join(',', filters);
    }

    internal static int GopFrames(double segmentLength, double frameRate)
        => Math.Max(1, (int)Math.Ceiling(segmentLength * frameRate - 1e-6));

    private static string QsvPreset(string preset) => preset switch
    {
        "ultrafast" or "superfast" or "veryfast" => "veryfast",
        "faster" => "faster",
        "fast" => "fast",
        "medium" => "medium",
        _ => "slow",
    };

    private static string NvencPreset(string preset) => preset switch
    {
        "ultrafast" or "superfast" or "veryfast" => "p1",
        "faster" => "p2",
        "fast" => "p3",
        "medium" => "p4",
        _ => "p5",
    };

    internal static string Seconds(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);

    private static string Micros(double value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    private static string Kbps(int kbps) => $"{kbps.ToString(CultureInfo.InvariantCulture)}k";
}
