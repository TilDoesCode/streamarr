namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Merged watched-time intervals for one external playback scope (work × playback session ×
/// user). Folded from progress heartbeats at ingest time — the raw heartbeats are collapsed
/// elsewhere — and each interval is attributed to the stream capability token it was watched
/// through, so release switches inside one sitting stay visible.
/// </summary>
public sealed class PlaybackRangeEntity
{
    public long Id { get; set; }

    /// <summary>Stable dedupe key: source | playbackSessionId-or-user | workId.</summary>
    public string ScopeKey { get; set; } = string.Empty;

    public string WorkId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
    public string PlaybackSessionId { get; set; } = string.Empty;
    public string ExternalUserId { get; set; } = string.Empty;
    public string ExternalUserName { get; set; } = string.Empty;
    public string DeviceName { get; set; } = string.Empty;

    /// <summary>Largest media duration reported for this scope, in 100 ns ticks.</summary>
    public long DurationTicks { get; set; }

    /// <summary>Latest playhead position, in 100 ns ticks.</summary>
    public long PositionTicks { get; set; }

    public string LastSessionToken { get; set; } = string.Empty;
    public string LastReleaseId { get; set; } = string.Empty;

    /// <summary>JSON array of {"s","e","t","r"} spans (ticks + token/release), merged, ordered by "s".</summary>
    public string RangesJson { get; set; } = "[]";

    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
