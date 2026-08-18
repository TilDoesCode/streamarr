using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services;

internal sealed class PreDownloadJob
{
    private readonly object _gate = new();
    private PreDownloadJobResponse _snapshot;

    public PreDownloadJob(
        string id,
        string kind,
        string reason,
        ActiveSession source,
        long watchPositionTicks,
        long watchDurationTicks,
        double? watchProgressPercent,
        double triggerThreshold,
        string triggerUnit,
        DateTimeOffset now)
    {
        _snapshot = new PreDownloadJobResponse
        {
            Id = id,
            State = "queued",
            Kind = kind,
            Reason = reason,
            Priority = "low",
            SourceToken = source.Token,
            SourceReleaseId = source.Session.ReleaseId,
            SourceWorkId = source.Session.WorkId,
            WatchPositionTicks = watchPositionTicks,
            WatchDurationTicks = watchDurationTicks,
            WatchProgressPercent = watchProgressPercent,
            TriggerThreshold = triggerThreshold,
            TriggerUnit = triggerUnit,
            QueuedAt = now,
            UpdatedAt = now,
        };
    }

    public string Id => _snapshot.Id;
    public string SourceToken => _snapshot.SourceToken;

    public PreDownloadJobResponse Snapshot()
    {
        lock (_gate)
            return _snapshot;
    }

    public void Start(DateTimeOffset now)
        => Update(current => current with
        {
            State = current.Kind == "nextEpisode" ? "resolving" : "downloading",
            StartedAt = now,
            UpdatedAt = now,
        });

    public void SetTarget(
        ActiveSession target,
        string? title,
        int? seasonNumber,
        int? episodeNumber,
        DateTimeOffset now)
        => Update(current => current with
        {
            TargetToken = target.Token,
            TargetReleaseId = target.Session.ReleaseId,
            TargetWorkId = target.Session.WorkId,
            TargetTitle = title ?? target.Title,
            TargetSeasonNumber = seasonNumber,
            TargetEpisodeNumber = episodeNumber,
            TotalBytes = target.File.SizeBytes,
            State = "downloading",
            UpdatedAt = now,
        });

    public void Progress(long bytes, long total, DateTimeOffset now)
        => Update(current => current with
        {
            BytesDownloaded = Math.Clamp(bytes, 0, total),
            TotalBytes = total,
            ProgressPercent = total <= 0 ? 0 : Math.Min(100, bytes * 100d / total),
            UpdatedAt = now,
        });

    public void Complete(DateTimeOffset now)
        => Update(current => current with
        {
            State = "completed",
            BytesDownloaded = current.TotalBytes,
            ProgressPercent = 100,
            UpdatedAt = now,
            CompletedAt = now,
        });

    public void End(string state, string code, string message, DateTimeOffset now)
        => Update(current => current with
        {
            State = state,
            ErrorCode = code,
            ErrorMessage = message,
            UpdatedAt = now,
            CompletedAt = now,
        });

    private void Update(Func<PreDownloadJobResponse, PreDownloadJobResponse> update)
    {
        lock (_gate)
            _snapshot = update(_snapshot);
    }
}
