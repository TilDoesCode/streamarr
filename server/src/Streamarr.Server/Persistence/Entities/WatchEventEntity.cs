namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// A playback event ingested from any front-end (BRIEF §6.1 module 7 / §6.2 POST
/// /events). Not user-facing in v1 — future-proofing for server-side watch state.
/// </summary>
public sealed class WatchEventEntity
{
    public long Id { get; set; }
    public string ReleaseId { get; set; } = string.Empty;
    public string WorkId { get; set; } = string.Empty;

    /// <summary>"start" | "progress" | "stop".</summary>
    public string Event { get; set; } = string.Empty;

    public long PositionTicks { get; set; }

    /// <summary>Originating front-end ("jellyfin" | "web" | …).</summary>
    public string Source { get; set; } = string.Empty;

    public DateTimeOffset ReceivedAt { get; set; }
}
