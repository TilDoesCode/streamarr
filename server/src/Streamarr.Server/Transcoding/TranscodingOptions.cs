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
    public int SegmentWaitTimeoutSeconds { get; set; } = 90;
    public int ProbeTimeoutSeconds { get; set; } = 45;
    public int CapabilityProbeTimeoutSeconds { get; set; } = 30;
    public int MaintenanceIntervalMilliseconds { get; set; } = 1_000;
}
