namespace Streamarr.Core.Sessions;

public enum SessionState
{
    Opening,
    Ready,
    Closed,
}

/// <summary>
/// A cached ephemeral file capability: created by /resolve, addressed by an opaque
/// unguessable token via /stream/{token}, and retained until explicit rejection,
/// size-based LRU eviction, or its hard TTL. Holds the segment index and (indirectly)
/// pooled NNTP resources.
/// </summary>
public sealed record StreamSession
{
    /// <summary>Opaque, unguessable stream token (not the release id).</summary>
    public required string Token { get; init; }

    public required string ReleaseId { get; init; }
    public required string WorkId { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }
    public required TimeSpan TimeToLive { get; init; }
    public DateTimeOffset LastAccessedAt { get; set; }

    public SessionState State { get; set; } = SessionState.Opening;

    /// <summary>Container of the primary media file (e.g. "mkv").</summary>
    public string? Container { get; init; }
    public long SizeBytes { get; init; }

    public long BytesServed { get; set; }

    /// <summary>Originating front-end ("jellyfin", "web", ...).</summary>
    public string? Client { get; init; }

    /// <summary>Stable account id and display name supplied by the originating front-end.</summary>
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }

    /// <summary>
    /// Hard expiry is based on creation rather than last access. Access only affects LRU
    /// ordering; it can never keep an ephemeral file alive beyond its configured maximum age.
    /// </summary>
    public DateTimeOffset ExpiresAt => CreatedAt + TimeToLive;
}
