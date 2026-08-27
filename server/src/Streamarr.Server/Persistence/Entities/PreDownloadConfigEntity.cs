namespace Streamarr.Server.Persistence.Entities;

/// <summary>Persisted singleton policy for implicit low-priority media downloads.</summary>
public sealed class PreDownloadConfigEntity
{
    public int Id { get; set; } = 1;
    public bool Enabled { get; set; }
    public bool DownloadCurrentFile { get; set; } = true;
    public int CurrentFileThresholdSeconds { get; set; } = 10;
    public bool DownloadNextEpisode { get; set; } = true;
    public int NextEpisodeThresholdPercent { get; set; } = 75;
    public bool PreferSimilarNextEpisodeRelease { get; set; }
    public int NextEpisodeReleaseSimilarityThresholdPercent { get; set; } = 75;
    public int MaxConcurrentDownloads { get; set; } = 1;
}
