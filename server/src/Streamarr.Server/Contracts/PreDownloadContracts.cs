using Streamarr.Server.Config;

namespace Streamarr.Server.Contracts;

/// <summary>Effective low-priority pre-download policy.</summary>
public sealed record PreDownloadConfigResponse
{
    public required bool Enabled { get; init; }
    public required bool DownloadCurrentFile { get; init; }
    public required int CurrentFileThresholdSeconds { get; init; }
    public required bool DownloadNextEpisode { get; init; }
    public required int NextEpisodeThresholdPercent { get; init; }
    public required int MaxConcurrentDownloads { get; init; }

    public static PreDownloadConfigResponse From(PreDownloadConfigSnapshot snapshot) => new()
    {
        Enabled = snapshot.Enabled,
        DownloadCurrentFile = snapshot.DownloadCurrentFile,
        CurrentFileThresholdSeconds = snapshot.CurrentFileThresholdSeconds,
        DownloadNextEpisode = snapshot.DownloadNextEpisode,
        NextEpisodeThresholdPercent = snapshot.NextEpisodeThresholdPercent,
        MaxConcurrentDownloads = snapshot.MaxConcurrentDownloads,
    };
}

/// <summary>Partial pre-download policy update; omitted properties retain their current values.</summary>
public sealed record PreDownloadConfigWrite
{
    public bool? Enabled { get; init; }
    public bool? DownloadCurrentFile { get; init; }
    public int? CurrentFileThresholdSeconds { get; init; }
    public bool? DownloadNextEpisode { get; init; }
    public int? NextEpisodeThresholdPercent { get; init; }
    public int? MaxConcurrentDownloads { get; init; }
}

/// <summary>Live or recently completed background materialization visible to operators.</summary>
public sealed record PreDownloadJobResponse
{
    public required string Id { get; init; }
    public required string State { get; init; }
    public required string Kind { get; init; }
    public required string Reason { get; init; }
    public required string Priority { get; init; }
    public required string SourceToken { get; init; }
    public required string SourceReleaseId { get; init; }
    public required string SourceWorkId { get; init; }
    public string? TargetToken { get; init; }
    public string? TargetReleaseId { get; init; }
    public string? TargetWorkId { get; init; }
    public string? TargetTitle { get; init; }
    public int? TargetSeasonNumber { get; init; }
    public int? TargetEpisodeNumber { get; init; }
    public long BytesDownloaded { get; init; }
    public long TotalBytes { get; init; }
    public double ProgressPercent { get; init; }
    public long WatchPositionTicks { get; init; }
    public long WatchDurationTicks { get; init; }
    public double? WatchProgressPercent { get; init; }
    public double TriggerThreshold { get; init; }
    public required string TriggerUnit { get; init; }
    public DateTimeOffset QueuedAt { get; init; }
    public DateTimeOffset? StartedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }
}
