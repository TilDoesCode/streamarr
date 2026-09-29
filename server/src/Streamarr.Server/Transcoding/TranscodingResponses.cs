namespace Streamarr.Server.Transcoding;

/// <summary>Domain → wire mapping for the transcoding API.</summary>
public static class TranscodingResponses
{
    private static readonly string[] InterestingFilters =
    [
        "scale", "zscale", "tonemap", "bwdif", "yadif", "hwupload", "hwdownload", "hwmap",
        "scale_vt", "scale_vaapi", "tonemap_vaapi", "deinterlace_vaapi", "vpp_qsv", "scale_qsv",
        "scale_cuda", "yadif_cuda", "tonemap_opencl", "hwupload_cuda",
    ];

    public static TranscodingConfigResponse Config(
        TranscodingSettings s, TranscodingOptions o, TranscodingWorkspace workspace, FfmpegCapabilities? caps) => new()
    {
        Enabled = s.Enabled,
        Acceleration = s.Acceleration.ToApi(),
        VaapiDevice = s.VaapiDevice,
        NvencDevice = s.NvencDevice,
        HardwareDecoding = s.HardwareDecoding,
        HardwareDecodingAuto = s.HardwareDecodingCodecs is null,
        HardwareDecodingCodecs = s.HardwareDecodingCodecs ?? caps?.For(s.Acceleration)?.ValidatedDecodeCodecs ?? [],
        HardwareEncoding = s.HardwareEncoding,
        ToneMapping = s.ToneMapping,
        AllowHevcOutput = s.AllowHevcOutput,
        EncoderPreset = s.EncoderPreset,
        Crf = s.Crf,
        MaxBitrateKbps = s.MaxBitrateKbps,
        MaxHeight = s.MaxHeight,
        AudioBitrateKbps = s.AudioBitrateKbps,
        AllowSurroundAudio = s.AllowSurroundAudio,
        SegmentLengthSeconds = s.SegmentLengthSeconds,
        ThrottleEnabled = s.ThrottleEnabled,
        ThrottleBufferSeconds = s.ThrottleBufferSeconds,
        MaxConcurrentTranscodes = s.MaxConcurrentTranscodes,
        MaxConcurrentRemuxes = s.MaxConcurrentRemuxes,
        JobIdleTimeoutSeconds = s.JobIdleTimeoutSeconds,
        SessionIdleTimeoutSeconds = s.SessionIdleTimeoutSeconds,
        SegmentRetentionSeconds = s.SegmentRetentionSeconds,
        Threads = s.Threads,
        FfmpegPath = o.FfmpegPath,
        FfprobePath = o.FfprobePath,
        WorkspacePath = workspace.Root,
        SamplesPath = workspace.SamplesRoot,
        WorkspaceBytes = workspace.SessionBytes(),
        ThrottleSupported = ProcessSignals.IsSupported,
        Accelerations = Enum.GetValues<HardwareAcceleration>().Select(a => a.ToApi()).ToList(),
        EncoderPresets = TranscodingSettings.SoftwarePresets,
        DecodeCodecs = DecodeCodecs.All,
    };

    public static TranscodingSettings Apply(TranscodingSettings current, TranscodingConfigWrite w, out string? error)
    {
        error = null;
        var acceleration = current.Acceleration;
        if (w.Acceleration is not null && !HardwareAccelerationNames.TryParse(w.Acceleration, out acceleration))
        {
            error = $"'acceleration' must be one of: {string.Join(", ", Enum.GetValues<HardwareAcceleration>().Select(a => a.ToApi()))}.";
            return current;
        }

        var codecs = current.HardwareDecodingCodecs;
        if (w.HardwareDecodingAuto == true)
            codecs = null;
        else if (w.HardwareDecodingCodecs is { } list)
            codecs = list.Select(c => c.Trim().ToLowerInvariant()).Distinct().ToList();

        return current with
        {
            Enabled = w.Enabled ?? current.Enabled,
            Acceleration = acceleration,
            VaapiDevice = w.VaapiDevice?.Trim() ?? current.VaapiDevice,
            NvencDevice = w.NvencDevice ?? current.NvencDevice,
            HardwareDecoding = w.HardwareDecoding ?? current.HardwareDecoding,
            HardwareDecodingCodecs = codecs,
            HardwareEncoding = w.HardwareEncoding ?? current.HardwareEncoding,
            ToneMapping = w.ToneMapping ?? current.ToneMapping,
            AllowHevcOutput = w.AllowHevcOutput ?? current.AllowHevcOutput,
            EncoderPreset = w.EncoderPreset ?? current.EncoderPreset,
            Crf = w.Crf ?? current.Crf,
            MaxBitrateKbps = w.MaxBitrateKbps ?? current.MaxBitrateKbps,
            MaxHeight = w.MaxHeight ?? current.MaxHeight,
            AudioBitrateKbps = w.AudioBitrateKbps ?? current.AudioBitrateKbps,
            AllowSurroundAudio = w.AllowSurroundAudio ?? current.AllowSurroundAudio,
            SegmentLengthSeconds = w.SegmentLengthSeconds ?? current.SegmentLengthSeconds,
            ThrottleEnabled = w.ThrottleEnabled ?? current.ThrottleEnabled,
            ThrottleBufferSeconds = w.ThrottleBufferSeconds ?? current.ThrottleBufferSeconds,
            MaxConcurrentTranscodes = w.MaxConcurrentTranscodes ?? current.MaxConcurrentTranscodes,
            MaxConcurrentRemuxes = w.MaxConcurrentRemuxes ?? current.MaxConcurrentRemuxes,
            JobIdleTimeoutSeconds = w.JobIdleTimeoutSeconds ?? current.JobIdleTimeoutSeconds,
            SessionIdleTimeoutSeconds = w.SessionIdleTimeoutSeconds ?? current.SessionIdleTimeoutSeconds,
            SegmentRetentionSeconds = w.SegmentRetentionSeconds ?? current.SegmentRetentionSeconds,
            Threads = w.Threads ?? current.Threads,
        };
    }

    public static TranscodingCapabilitiesResponse Capabilities(FfmpegCapabilities? caps, bool detecting)
    {
        if (caps is null)
            return new TranscodingCapabilitiesResponse { Detecting = detecting, Detected = false };
        return new TranscodingCapabilitiesResponse
        {
            Detecting = detecting,
            Detected = true,
            DetectedAt = caps.DetectedAt,
            DurationSeconds = Math.Round(caps.Duration.TotalSeconds, 2),
            FfmpegFound = caps.FfmpegFound,
            FfmpegPath = caps.FfmpegPath,
            Version = caps.Version,
            MajorVersion = caps.MajorVersion,
            MeetsMinimumVersion = caps.MeetsMinimumVersion,
            FfprobeFound = caps.FfprobeFound,
            FfprobeVersion = caps.FfprobeVersion,
            Error = caps.Error,
            Usable = caps.Usable,
            SoftwareToneMapping = caps.SoftwareToneMapping,
            RelativeKeyframeExpressions = caps.RelativeKeyframeExpressions,
            Recommended = caps.Recommended.ToApi(),
            Platform = new PlatformResponse(caps.Platform.Os, caps.Platform.Architecture, caps.Platform.InContainer,
                caps.Platform.CpuModel, caps.Platform.LogicalCores),
            Accelerators = caps.Accelerators.Select(Accelerator).ToList(),
            Devices = caps.Devices.Select(d => new GpuDeviceResponse
            {
                Id = d.Id,
                Kind = d.Kind == GpuDeviceKind.Cuda ? "cuda" : "drm",
                Label = d.Label,
                Vendor = d.Vendor,
                VendorId = d.VendorId,
                DeviceId = d.DeviceId,
                Driver = d.Driver,
                Name = d.Name,
                PciSlot = d.PciSlot,
                Index = d.Index,
                Checks = d.Checks.Select(c => new DeviceCheckResponse(c.Key.ToApi(), c.Value.Passed, c.Value.Detail)).ToList(),
            }).ToList(),
            VideoEncoders = caps.Encoders
                .Where(e => e is "libx264" or "libx265" or "libsvtav1" || e.StartsWith("h264_", StringComparison.Ordinal)
                            || e.StartsWith("hevc_", StringComparison.Ordinal) || e.StartsWith("av1_", StringComparison.Ordinal))
                .Order(StringComparer.Ordinal).ToList(),
            AudioEncoders = caps.Encoders.Where(e => e is "aac" or "libfdk_aac" or "aac_at" or "ac3" or "eac3" or "libopus" or "libmp3lame")
                .Order(StringComparer.Ordinal).ToList(),
            HwAccels = caps.HwAccels.Order(StringComparer.Ordinal).ToList(),
            Filters = InterestingFilters.Where(caps.Filters.Contains).ToList(),
        };
    }

    private static AcceleratorResponse Accelerator(AcceleratorCapability a) => new()
    {
        Id = a.Kind.ToApi(),
        Label = a.Kind.Label(),
        Status = !a.PlatformSupported ? "not-applicable"
            : !a.CompiledIn ? "unavailable"
            : a.DevicePresent == false ? "no-device"
            : a.H264Encode.Passed == true && a.Decode.Values.Any(d => d.Passed == true) ? "ready"
            : a.Usable ? "partial"
            : "failed",
        PlatformSupported = a.PlatformSupported,
        CompiledIn = a.CompiledIn,
        DevicePresent = a.DevicePresent,
        Device = a.Device,
        H264Encode = new CapabilityCheckResponse(a.H264Encode.Passed, a.H264Encode.Detail),
        HevcEncode = new CapabilityCheckResponse(a.HevcEncode.Passed, a.HevcEncode.Detail),
        Decode = DecodeCodecs.All.Select(c => a.Decode.TryGetValue(c, out var check)
            ? new DecodeCheckResponse(c, check.Passed, check.Detail)
            : new DecodeCheckResponse(c, null, null)).ToList(),
        ToneMapping = new CapabilityCheckResponse(a.ToneMapping.Passed, a.ToneMapping.Detail),
        Notes = a.Notes,
        AlternativeDevice = a.AlternativeDevice,
    };

    public static TranscodingSampleResponse Sample(SampleStatus status) => new()
    {
        Id = status.Sample.Id,
        Title = status.Sample.Title,
        Description = status.Sample.Description,
        Video = status.Sample.VideoSummary,
        Audio = status.Sample.AudioSummary,
        DurationSeconds = status.Sample.DurationSeconds,
        State = status.State.ToString().ToLowerInvariant(),
        Progress = Math.Round(status.Progress, 3),
        SizeBytes = status.SizeBytes,
        Error = status.Error,
    };

    public static TranscodePlanResponse Plan(TranscodePlan plan, SourceMediaInfo media) => new()
    {
        Mode = plan.Mode.ToApi(),
        Reasons = plan.Reasons.Select(Reason).ToList(),
        RemuxPossible = plan.RemuxPossible,
        RemuxBlockers = plan.RemuxBlockers.Select(Reason).ToList(),
        Subtitles = plan.Subtitles.Select(s => new SubtitleTrackResponse
        {
            Index = s.Stream.Index,
            Codec = s.Stream.Codec,
            Language = s.Language,
            Title = s.Stream.Title,
            Name = s.Name,
            Forced = s.Stream.IsForced,
            IsDefault = s.Stream.IsDefault,
            TextBased = s.Stream.TextBased,
            DeliveredAs = s.DeliveredAs,
        }).ToList(),
        KeyframeIndex = plan.KeyframeIndex is not { } index ? null : new KeyframeIndexResponse
        {
            Source = index.Source.ToApi(),
            Keyframes = index.Keyframes.Count,
            BuildMs = Math.Round(index.BuildMs),
            Segments = plan.RemuxTimeline?.Count ?? 0,
            MaxSegmentSeconds = Math.Round(plan.RemuxTimeline?.MaxDuration ?? 0, 3),
        },
        DirectPlayPossible = plan.DirectPlayPossible,
        DirectPlayBlockers = plan.DirectPlayBlockers,
        Source = new TranscodeSourceResponse
        {
            Container = TranscodePlanner.ContainerFamily(media.Container),
            DurationSeconds = Math.Round(media.DurationSeconds, 3),
            BitrateKbps = media.BitRate is { } b ? (int)(b / 1000) : null,
            VideoCodec = plan.SourceVideo.Codec,
            VideoProfile = plan.SourceVideo.Profile,
            Width = plan.SourceVideo.Width,
            Height = plan.SourceVideo.Height,
            BitDepth = plan.SourceVideo.BitDepth,
            FrameRate = plan.SourceVideo.FrameRate is { } f ? Math.Round(f, 3) : null,
            Hdr = plan.SourceVideo.Hdr.ToString().ToLowerInvariant(),
            DolbyVisionProfile = plan.SourceVideo.DolbyVisionProfile,
            Interlaced = plan.SourceVideo.Interlaced,
            Audio = media.Audio.Select(a => new SourceAudioResponse(a.Index, a.Codec, a.Channels, a.Language, a.Title, a.IsDefault)).ToList(),
        },
        Target = new TranscodeTargetResponse
        {
            VideoCodec = plan.Video.Codec,
            Width = plan.Video.Width,
            Height = plan.Video.Height,
            VideoBitrateKbps = plan.Video.BitrateKbps,
            FrameRate = Math.Round(plan.Video.FrameRate, 3),
            Level = plan.Video.Level,
            Codecs = plan.CodecsAttribute,
            VideoCopy = plan.Mode != DeliveryMode.Transcode,
            VideoRange = plan.Mode == DeliveryMode.Transcode ? "SDR" : plan.VideoRange,
            AudioStreamIndex = plan.Audio?.SourceIndex,
            AudioSourceCodec = plan.Audio?.SourceCodec,
            AudioCodec = plan.Audio?.Codec,
            AudioCopy = plan.Audio?.Copy ?? false,
            AudioChannels = plan.Audio?.Channels,
            AudioBitrateKbps = plan.Audio?.BitrateKbps,
        },
        Acceleration = plan.Acceleration.ToApi(),
        AccelerationLabel = plan.Acceleration.Label(),
        HardwareDecode = plan.HardwareDecode,
        HardwareDecodeReason = plan.HardwareDecodeReason,
        HardwareEncode = plan.HardwareEncode,
        HardwareEncodeReason = plan.HardwareEncodeReason,
        Encoder = plan.Encoder,
        ToneMap = plan.ToneMap.ToString().ToLowerInvariant(),
        Deinterlace = plan.Deinterlace,
        VideoFilters = plan.Mode == DeliveryMode.Transcode ? FfmpegArgumentBuilder.BuildVideoFilters(plan) : string.Empty,
        Warnings = plan.Warnings,
    };

    private static PlanReasonResponse Reason(PlanReason reason) => new(reason.Code, reason.Message, reason.Params);

    public static TranscodeSessionResponse Session(TranscodeSession s)
    {
        var job = s.Job;
        return new TranscodeSessionResponse
        {
            Handle = s.Handle,
            Mode = s.Mode.ToApi(),
            Title = s.Title,
            Client = s.Client,
            SourceKind = s.Source.Kind,
            CreatedAt = s.CreatedAt,
            LastAccessAt = s.LastAccessAt,
            SegmentCount = s.Timeline.Count,
            SegmentLengthSeconds = s.Timeline.SegmentLength,
            LastRequestedSegment = s.LastRequestedSegment,
            SegmentsServed = s.SegmentsServed,
            BytesServed = s.BytesServed,
            Restarts = s.Restarts,
            TimeToFirstSegmentMs = s.FirstSegmentServedAt is { } first
                ? Math.Round((first - (s.Startup?.RequestedAt ?? s.CreatedAt)).TotalMilliseconds)
                : null,
            Startup = s.Startup is not { } startup ? null : new TranscodeStartupResponse
            {
                CapabilitiesMs = Math.Round(startup.CapabilitiesMs),
                ProbeMs = Math.Round(startup.ProbeMs),
                ProbeCached = startup.ProbeCached,
                PlanMs = Math.Round(startup.PlanMs, 1),
                SpawnMs = Math.Round(startup.SpawnMs),
                FirstSegmentReadyMs = s.FirstRunFirstSegmentAt is { } ready ? Math.Round((ready - startup.RequestedAt).TotalMilliseconds) : null,
                FirstSegmentServedMs = s.FirstSegmentServedAt is { } served ? Math.Round((served - startup.RequestedAt).TotalMilliseconds) : null,
            },
            LastError = s.LastError,
            Job = job is null ? null : new TranscodeJobResponse
            {
                StartSegment = job.StartSegment,
                Front = job.Front(),
                Running = !job.HasExited,
                Paused = job.Paused,
                Fps = Math.Round(job.Fps, 1),
                Speed = Math.Round(job.Speed, 2),
                Frames = job.Frames,
                CpuSeconds = Math.Round(job.CpuTime.TotalSeconds, 1),
                ExitCode = job.ExitCode,
                StoppedByServer = job.Killed,
                StartedAt = job.StartedAt,
                TimeToFirstSegmentMs = job.FirstSegmentAt is { } at ? (at - job.StartedAt).TotalMilliseconds : null,
                Log = job.LogTail().Select(l => l.Replace(s.Id, "{session}", StringComparison.Ordinal)).ToList(),
                Command = job.Arguments.Select(a => a.Replace(s.Id, "{session}", StringComparison.Ordinal)).ToList(),
            },
            Plan = Plan(s.Plan, s.Media),
        };
    }

    public static BenchmarkResponse Benchmark(BenchmarkRun run, TranscodingSettings settings)
    {
        var sample = TranscodingSampleLibrary.Find(run.Request.SampleId);
        var r = run.Result;
        return new BenchmarkResponse
        {
            Id = run.Id,
            SampleId = run.Request.SampleId,
            SampleTitle = sample?.Title ?? run.Request.SampleId,
            MaxHeight = run.Request.MaxHeight,
            BitrateKbps = run.Request.BitrateKbps,
            Acceleration = (run.Plan?.Acceleration ?? run.Request.Acceleration ?? settings.Acceleration).ToApi(),
            State = run.State switch
            {
                BenchmarkState.PreparingSample => "preparing-sample",
                _ => run.State.ToString().ToLowerInvariant(),
            },
            Progress = Math.Round(run.Progress, 3),
            CreatedAt = run.CreatedAt,
            StartedAt = run.StartedAt,
            FinishedAt = run.FinishedAt,
            Error = run.Error,
            ActiveTranscodesAtStart = run.ActiveTranscodesAtStart,
            Plan = run.Plan is null ? null : Plan(run.Plan, run.Media ?? new SourceMediaInfo { DurationSeconds = run.Plan.DurationSeconds, Video = run.Plan.SourceVideo }),
            Result = r is null ? null : new BenchmarkResultResponse
            {
                Verdict = r.Verdict,
                Summary = r.Summary,
                MediaSeconds = Math.Round(r.MediaSeconds, 2),
                WallSeconds = Math.Round(r.WallSeconds, 2),
                Speed = Math.Round(r.Speed, 2),
                Fps = Math.Round(r.Fps, 1),
                CpuSeconds = Math.Round(r.CpuSeconds, 1),
                AverageCpuCores = Math.Round(r.AverageCpuCores, 2),
                CpuSharePercent = Math.Round(r.AverageCpuCores / Math.Max(1, Environment.ProcessorCount) * 100, 1),
                TimeToFirstSegmentMs = r.TimeToFirstSegmentMs is { } t ? Math.Round(t) : null,
                SeekTimeToFirstSegmentMs = r.SeekTimeToFirstSegmentMs is { } st ? Math.Round(st) : null,
                Segments = r.Segments,
                ExpectedSegments = r.ExpectedSegments,
                KeyframesAligned = r.KeyframesAligned,
                MaxDriftMs = Math.Round(r.MaxDriftMs, 1),
                OutputBitrateKbps = r.OutputBitrateKbps,
                OutputWidth = r.OutputWidth,
                OutputHeight = r.OutputHeight,
                HardwareFallbackDetected = r.HardwareFallbackDetected,
                SegmentChecks = r.SegmentChecks.Select(c => new SegmentCheckResponse(
                    c.Index, Math.Round(c.StartSeconds, 3), Math.Round(c.DurationSeconds, 3), c.StartsWithKeyframe, Math.Round(c.DriftMs, 1))).ToList(),
                Warnings = r.Warnings,
                Command = r.Command,
                Log = r.Log,
            },
        };
    }
}
