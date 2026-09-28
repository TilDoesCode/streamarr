namespace Streamarr.Server.Persistence.Entities;

/// <summary>Per-viewer resume position and played state of one work (movie or episode).</summary>
public sealed class ViewerWatchStateEntity
{
    public long Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;
    public string WorkId { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public int? TmdbId { get; set; }
    public string? SeriesWorkId { get; set; }
    public int? SeasonNumber { get; set; }
    public int? EpisodeNumber { get; set; }
    public string? Title { get; set; }
    public long PositionTicks { get; set; }
    public long? DurationTicks { get; set; }
    public bool Played { get; set; }
    public int PlayCount { get; set; }
    public string? LastReleaseId { get; set; }
    public string? LastPlaybackId { get; set; }
    public string? CountedPlaybackId { get; set; }
    public DateTimeOffset? LastPlayedAt { get; set; }
    public DateTimeOffset? PlayedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
