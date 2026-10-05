namespace Streamarr.Server.Transcoding;

/// <summary>Host-level transcoding infrastructure, bound from <c>Streamarr:Transcoding</c> and never editable over HTTP.</summary>
public sealed class TranscodingOptions
{
    public const string SectionName = "Streamarr:Transcoding";

    public string FfmpegPath { get; set; } = "ffmpeg";
    public string FfprobePath { get; set; } = "ffprobe";
    public string WorkspacePath { get; set; } = string.Empty;
    public string SamplesPath { get; set; } = string.Empty;

    /// <summary>Overrides the loopback origin ffmpeg uses to read <c>/api/v1/stream</c> (e.g. <c>http://127.0.0.1:8080</c>).</summary>
    public string LocalSourceBaseUrl { get; set; } = string.Empty;

    public int MaxSessions { get; set; } = 16;
    /// <summary>Longest a segment, init or WebVTT request waits for ffmpeg before <c>504 segment_timeout</c> (with <c>Retry-After</c>).</summary>
    public int SegmentWaitTimeoutSeconds { get; set; } = 25;
    public int ProbeTimeoutSeconds { get; set; } = 45;
    public int CapabilityProbeTimeoutSeconds { get; set; } = 30;
    public int MaintenanceIntervalMilliseconds { get; set; } = 1_000;

    /// <summary>Budget for reading a remux keyframe index from the container (Matroska Cues, MP4 sample table).</summary>
    public int KeyframeIndexTimeoutSeconds { get; set; } = 30;

    /// <summary>Budget for the ffprobe packet scan used when the container has no usable index.</summary>
    public int KeyframeScanTimeoutSeconds { get; set; } = 20;
}
