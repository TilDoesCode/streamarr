namespace Streamarr.Server.Persistence.Entities;

/// <summary>Metadata for one NZB persisted in Core's bounded on-disk cache.</summary>
public sealed class CachedReleaseEntity
{
    public string ReleaseId { get; set; } = string.Empty;
    public string WorkId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Indexer { get; set; } = string.Empty;
    public string CacheFileName { get; set; } = string.Empty;
    public long ReleaseSizeBytes { get; set; }
    public long NzbSizeBytes { get; set; }
    public int FileCount { get; set; }
    public int SegmentCount { get; set; }
    public long HitCount { get; set; }
    public DateTimeOffset CachedAt { get; set; }
    public DateTimeOffset LastAccessedAt { get; set; }
    public string? MediaProbeKey { get; set; }
    public string? MediaProbeJson { get; set; }
    public DateTimeOffset? MediaProbeCachedAt { get; set; }
    public string? ReleaseRegistrationJson { get; set; }
}
