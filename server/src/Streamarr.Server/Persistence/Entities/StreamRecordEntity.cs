namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// One resolve attempt — live, cleanly closed, or failed before a session ever
/// existed — retained permanently (bounded to the newest
/// <see cref="Options.StreamarrOptions.MaxRetainedStreams"/> closed rows) so a
/// stream can be dissected after the fact even once its in-memory
/// <c>ActiveSession</c>/<c>TtffTimeline</c> is long gone. See
/// <see cref="Services.StreamHistoryRecorder"/>.
/// </summary>
public sealed class StreamRecordEntity
{
    public long Id { get; set; }

    /// <summary>Synthetic id minted at attempt start, before any session token may exist. Immutable.</summary>
    public string AttemptId { get; set; } = string.Empty;

    /// <summary>The real session token once one is minted by SessionManager; null for attempts that never opened one.</summary>
    public string? Token { get; set; }

    public string ReleaseId { get; set; } = string.Empty;
    public string WorkId { get; set; } = string.Empty;
    public string? Title { get; set; }
    /// <summary>The actual fallback release used for playback, when it differs from the requested release.</summary>
    public string? ResolvedReleaseId { get; set; }
    public string? ResolvedTitle { get; set; }
    public string? Container { get; set; }
    public long? SizeBytes { get; set; }
    public long BytesServed { get; set; }
    public long NntpCommandsTotal { get; set; }

    /// <summary>Originating front-end ("jellyfin" | "web" | …).</summary>
    public string? Client { get; set; }
    public string? RequestedById { get; set; }
    public string? RequestedByName { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }

    /// <summary>Null while open; terminal values include closed, interrupted, expired, evicted, purged, invalidated, reused, dead, and error.</summary>
    public string? FinalState { get; set; }

    /// <summary>Operator-facing close reason — never a raw exception message (BRIEF: no secrets/paths/ids in logs).</summary>
    public string? CloseReason { get; set; }

    public DateTimeOffset? TimelineStartedAt { get; set; }

    public List<StreamEventEntity> Events { get; set; } = [];
}

/// <summary>
/// One chronological diagnostic entry for a <see cref="StreamRecordEntity"/>: a
/// TTFF span, a folded-in PAR2 repair-job transition, a session-lifecycle
/// milestone, or an error. Detail text is expected to already be redacted by its
/// source (see <c>TtffSpan.Detail</c>, <c>RepairJobEvent.Message</c>).
/// </summary>
public sealed class StreamEventEntity
{
    public long Id { get; set; }
    public long StreamRecordId { get; set; }
    public DateTimeOffset AtUtc { get; set; }

    /// <summary>"ttff" | "lifecycle" | "repair" | "error".</summary>
    public string Source { get; set; } = string.Empty;

    /// <summary>Coarse bucket, e.g. nzb/health/materialize/probe/session/stream/transcode/client/repair state name.</summary>
    public string Category { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;
    public string? Detail { get; set; }

    /// <summary>Milliseconds from the stream's t0, when meaningful (ttff spans only).</summary>
    public double? StartMs { get; set; }
    public double? DurationMs { get; set; }
}
