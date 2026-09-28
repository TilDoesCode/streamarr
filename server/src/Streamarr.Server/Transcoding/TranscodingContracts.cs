using System.ComponentModel.DataAnnotations;

namespace Streamarr.Server.Transcoding;

public sealed record TranscodingConfigResponse
{
    public required bool Enabled { get; init; }
    public required string Acceleration { get; init; }
    public required string VaapiDevice { get; init; }
    public required int NvencDevice { get; init; }
    public required bool HardwareDecoding { get; init; }
    public required bool HardwareDecodingAuto { get; init; }
    public required IReadOnlyList<string> HardwareDecodingCodecs { get; init; }
    public required bool HardwareEncoding { get; init; }
    public required bool ToneMapping { get; init; }
    public required bool AllowHevcOutput { get; init; }
    public required string EncoderPreset { get; init; }
    public required int Crf { get; init; }
    public required int MaxBitrateKbps { get; init; }
    public required int MaxHeight { get; init; }
    public required int AudioBitrateKbps { get; init; }
    public required bool AllowSurroundAudio { get; init; }
    public required int SegmentLengthSeconds { get; init; }
    public required bool ThrottleEnabled { get; init; }
    public required int ThrottleBufferSeconds { get; init; }
    public required int MaxConcurrentTranscodes { get; init; }
    public required int JobIdleTimeoutSeconds { get; init; }
    public required int SessionIdleTimeoutSeconds { get; init; }
    public required int SegmentRetentionSeconds { get; init; }
    public required int Threads { get; init; }

    /// <summary>Host-level paths; only configurable through environment/appsettings.</summary>
    public required string FfmpegPath { get; init; }
    public required string FfprobePath { get; init; }
    public required string WorkspacePath { get; init; }
    public required string SamplesPath { get; init; }
    public required long WorkspaceBytes { get; init; }
    public required bool ThrottleSupported { get; init; }
    public required IReadOnlyList<string> Accelerations { get; init; }
    public required IReadOnlyList<string> EncoderPresets { get; init; }
    public required IReadOnlyList<string> DecodeCodecs { get; init; }
}

/// <summary>Partial update; omitted fields keep their value.</summary>
public sealed record TranscodingConfigWrite
{
    public bool? Enabled { get; init; }
    public string? Acceleration { get; init; }
    [MaxLength(64)] public string? VaapiDevice { get; init; }

    /// <summary>NVIDIA GPU index for NVENC/NVDEC in nvidia-smi (PCI bus) order.</summary>
    [Range(0, 15)]
    public int? NvencDevice { get; init; }

    public bool? HardwareDecoding { get; init; }
    public bool? HardwareDecodingAuto { get; init; }
    [MaxLength(16)] public IReadOnlyList<string>? HardwareDecodingCodecs { get; init; }
    public bool? HardwareEncoding { get; init; }
    public bool? ToneMapping { get; init; }
    public bool? AllowHevcOutput { get; init; }
    [MaxLength(16)] public string? EncoderPreset { get; init; }
    public int? Crf { get; init; }
    public int? MaxBitrateKbps { get; init; }
    public int? MaxHeight { get; init; }
    public int? AudioBitrateKbps { get; init; }
    public bool? AllowSurroundAudio { get; init; }
    public int? SegmentLengthSeconds { get; init; }
    public bool? ThrottleEnabled { get; init; }
    public int? ThrottleBufferSeconds { get; init; }
    public int? MaxConcurrentTranscodes { get; init; }
    public int? JobIdleTimeoutSeconds { get; init; }
    public int? SessionIdleTimeoutSeconds { get; init; }
    public int? SegmentRetentionSeconds { get; init; }
    public int? Threads { get; init; }
}

public sealed record CapabilityCheckResponse(bool? Passed, string? Detail);

public sealed record DecodeCheckResponse(string Codec, bool? Passed, string? Detail);

public sealed record AcceleratorResponse
{
    public required string Id { get; init; }
    public required string Label { get; init; }
    public required string Status { get; init; }
    public required bool PlatformSupported { get; init; }
    public required bool CompiledIn { get; init; }
    public bool? DevicePresent { get; init; }
    public string? Device { get; init; }
    public required CapabilityCheckResponse H264Encode { get; init; }
    public required CapabilityCheckResponse HevcEncode { get; init; }
    public required IReadOnlyList<DecodeCheckResponse> Decode { get; init; }
    public required CapabilityCheckResponse ToneMapping { get; init; }
    public required IReadOnlyList<string> Notes { get; init; }

    /// <summary>Another GPU that passed this backend's encode test while the configured one failed or is missing.</summary>
    public string? AlternativeDevice { get; init; }
}

public sealed record DeviceCheckResponse(string Backend, bool? Passed, string? Detail);

/// <summary>A GPU visible to the server: a DRM render node (VA-API/QSV) or an NVIDIA GPU (NVENC) in nvidia-smi numbering.</summary>
public sealed record GpuDeviceResponse
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required string Label { get; init; }
    public string? Vendor { get; init; }
    public string? VendorId { get; init; }
    public string? DeviceId { get; init; }
    public string? Driver { get; init; }
    public string? Name { get; init; }
    public string? PciSlot { get; init; }
    public int? Index { get; init; }
    public required IReadOnlyList<DeviceCheckResponse> Checks { get; init; }
}

public sealed record PlatformResponse(string Os, string Architecture, bool InContainer, string? CpuModel, int LogicalCores);

public sealed record TranscodingCapabilitiesResponse
{
    public required bool Detecting { get; init; }
    public required bool Detected { get; init; }
    public DateTimeOffset? DetectedAt { get; init; }
    public double DurationSeconds { get; init; }
    public bool FfmpegFound { get; init; }
    public string FfmpegPath { get; init; } = string.Empty;
    public string? Version { get; init; }
    public int? MajorVersion { get; init; }
    public bool MeetsMinimumVersion { get; init; }
    public bool FfprobeFound { get; init; }
    public string? FfprobeVersion { get; init; }
    public string? Error { get; init; }
    public bool Usable { get; init; }
    public bool SoftwareToneMapping { get; init; }
    public bool RelativeKeyframeExpressions { get; init; }
    public string Recommended { get; init; } = "none";
    public PlatformResponse? Platform { get; init; }
    public IReadOnlyList<AcceleratorResponse> Accelerators { get; init; } = [];
    public IReadOnlyList<GpuDeviceResponse> Devices { get; init; } = [];
    public IReadOnlyList<string> VideoEncoders { get; init; } = [];
    public IReadOnlyList<string> AudioEncoders { get; init; } = [];
    public IReadOnlyList<string> HwAccels { get; init; } = [];
    public IReadOnlyList<string> Filters { get; init; } = [];
}

public sealed record TranscodingSampleResponse
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Description { get; init; }
    public required string Video { get; init; }
    public required string Audio { get; init; }
    public required double DurationSeconds { get; init; }
    public required string State { get; init; }
    public required double Progress { get; init; }
    public long? SizeBytes { get; init; }
    public string? Error { get; init; }
}

public sealed record SourceAudioResponse(int Index, string Codec, int Channels, string? Language, string? Title, bool IsDefault);

public sealed record TranscodeSourceResponse
{
    public string? Container { get; init; }
    public required double DurationSeconds { get; init; }
    public int? BitrateKbps { get; init; }
    public required string VideoCodec { get; init; }
    public string? VideoProfile { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required int BitDepth { get; init; }
    public double? FrameRate { get; init; }
    public required string Hdr { get; init; }
    public required bool Interlaced { get; init; }
    public required IReadOnlyList<SourceAudioResponse> Audio { get; init; }
}

public sealed record TranscodeTargetResponse
{
    public required string VideoCodec { get; init; }
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required int VideoBitrateKbps { get; init; }
    public required double FrameRate { get; init; }
    public required string Level { get; init; }
    public required string Codecs { get; init; }
    public int? AudioStreamIndex { get; init; }
    public string? AudioSourceCodec { get; init; }
    public bool AudioCopy { get; init; }
    public int? AudioChannels { get; init; }
    public int? AudioBitrateKbps { get; init; }
}

public sealed record TranscodePlanResponse
{
    public required bool DirectPlayPossible { get; init; }
    public required IReadOnlyList<string> DirectPlayBlockers { get; init; }
    public required TranscodeSourceResponse Source { get; init; }
    public required TranscodeTargetResponse Target { get; init; }
    public required string Acceleration { get; init; }
    public required string AccelerationLabel { get; init; }
    public required bool HardwareDecode { get; init; }
    public required string HardwareDecodeReason { get; init; }
    public required bool HardwareEncode { get; init; }
    public required string HardwareEncodeReason { get; init; }
    public required string Encoder { get; init; }
    public required string ToneMap { get; init; }
    public required bool Deinterlace { get; init; }
    public required string VideoFilters { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
}

public sealed record ClientProfileRequest
{
    [MaxLength(16)] public IReadOnlyList<string>? VideoCodecs { get; init; }
    [MaxLength(16)] public IReadOnlyList<string>? AudioCodecs { get; init; }
    [MaxLength(16)] public IReadOnlyList<string>? Containers { get; init; }
    public int? MaxAudioChannels { get; init; }
    public bool? SupportsHdr { get; init; }
    public bool? Supports10Bit { get; init; }
}

public sealed record TranscodeSessionCreateRequest
{
    /// <summary>A live stream capability returned by /resolve (the path token of <c>/api/v1/stream/{token}</c>).</summary>
    [MaxLength(128)] public string? StreamToken { get; init; }

    /// <summary>A built-in test sample id (administrators only).</summary>
    [MaxLength(64)] public string? SampleId { get; init; }

    public ClientProfileRequest? Client { get; init; }
    public int? MaxHeight { get; init; }
    public int? MaxBitrateKbps { get; init; }
    public int? AudioStreamIndex { get; init; }
    public double? StartPositionSeconds { get; init; }
    [MaxLength(64)] public string? ClientName { get; init; }
}

public sealed record TranscodeSessionCreatedResponse
{
    public required string Handle { get; init; }
    public required string PlaylistUrl { get; init; }
    public required string MediaPlaylistUrl { get; init; }
    public required double DurationSeconds { get; init; }
    public required double SegmentLengthSeconds { get; init; }
    public required int SegmentCount { get; init; }
    public required TranscodePlanResponse Plan { get; init; }
}

public sealed record TranscodeJobResponse
{
    public required int StartSegment { get; init; }
    public required int Front { get; init; }
    public required bool Running { get; init; }
    public required bool Paused { get; init; }
    public required double Fps { get; init; }
    public required double Speed { get; init; }
    public required long Frames { get; init; }
    public required double CpuSeconds { get; init; }
    public int? ExitCode { get; init; }

    /// <summary>True when Streamarr stopped the run on purpose (idle player, session closed), so a non-zero exit code is expected.</summary>
    public bool StoppedByServer { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public double? TimeToFirstSegmentMs { get; init; }
    public required IReadOnlyList<string> Log { get; init; }
    public required IReadOnlyList<string> Command { get; init; }
}

/// <summary>Where a session's time to first segment went, measured on the server from the create request.</summary>
public sealed record TranscodeStartupResponse
{
    public required double CapabilitiesMs { get; init; }
    public required double ProbeMs { get; init; }
    public required bool ProbeCached { get; init; }
    public required double PlanMs { get; init; }
    public required double SpawnMs { get; init; }

    /// <summary>Create request → first segment written by ffmpeg.</summary>
    public double? FirstSegmentReadyMs { get; init; }

    /// <summary>Create request → first segment delivered to the player.</summary>
    public double? FirstSegmentServedMs { get; init; }
}

public sealed record TranscodeSessionResponse
{
    public required string Handle { get; init; }
    public required string Title { get; init; }
    public required string Client { get; init; }
    public required string SourceKind { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset LastAccessAt { get; init; }
    public required int SegmentCount { get; init; }
    public required double SegmentLengthSeconds { get; init; }
    public required int LastRequestedSegment { get; init; }
    public required long SegmentsServed { get; init; }
    public required long BytesServed { get; init; }
    public required int Restarts { get; init; }
    public double? TimeToFirstSegmentMs { get; init; }
    public TranscodeStartupResponse? Startup { get; init; }
    public string? LastError { get; init; }
    public TranscodeJobResponse? Job { get; init; }
    public required TranscodePlanResponse Plan { get; init; }
}

public sealed record BenchmarkCreateRequest
{
    [Required, MaxLength(64)] public string SampleId { get; init; } = string.Empty;
    public int? MaxHeight { get; init; }
    public int? BitrateKbps { get; init; }

    /// <summary>Override the configured backend for this run only (none, videotoolbox, vaapi, qsv, nvenc).</summary>
    [MaxLength(16)] public string? Acceleration { get; init; }
}

public sealed record SegmentCheckResponse(int Index, double StartSeconds, double DurationSeconds, bool StartsWithKeyframe, double DriftMs);

public sealed record BenchmarkResultResponse
{
    public required string Verdict { get; init; }
    public required string Summary { get; init; }
    public double MediaSeconds { get; init; }
    public double WallSeconds { get; init; }
    public double Speed { get; init; }
    public double Fps { get; init; }
    public double CpuSeconds { get; init; }
    public double AverageCpuCores { get; init; }
    public double? CpuSharePercent { get; init; }
    public double? TimeToFirstSegmentMs { get; init; }
    public double? SeekTimeToFirstSegmentMs { get; init; }
    public int Segments { get; init; }
    public int ExpectedSegments { get; init; }
    public bool KeyframesAligned { get; init; }
    public double MaxDriftMs { get; init; }
    public int? OutputBitrateKbps { get; init; }
    public int? OutputWidth { get; init; }
    public int? OutputHeight { get; init; }
    public bool HardwareFallbackDetected { get; init; }
    public required IReadOnlyList<SegmentCheckResponse> SegmentChecks { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
    public required IReadOnlyList<string> Command { get; init; }
    public string? Log { get; init; }
}

public sealed record BenchmarkResponse
{
    public required string Id { get; init; }
    public required string SampleId { get; init; }
    public required string SampleTitle { get; init; }
    public required int MaxHeight { get; init; }
    public required int BitrateKbps { get; init; }
    public required string Acceleration { get; init; }
    public required string State { get; init; }
    public required double Progress { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public string? Error { get; init; }
    public int ActiveTranscodesAtStart { get; init; }
    public TranscodePlanResponse? Plan { get; init; }
    public BenchmarkResultResponse? Result { get; init; }
}
