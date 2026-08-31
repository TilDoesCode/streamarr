namespace Streamarr.Server.Contracts;

/// <summary>One watched span of the media timeline, in 100 ns ticks.</summary>
public sealed record PlaybackRangeSpanResponse
{
    public long StartTicks { get; init; }
    public long EndTicks { get; init; }

    /// <summary>Capability token this span was watched through; null when the front-end sent none.</summary>
    public string? SessionToken { get; init; }

    public string? ReleaseId { get; init; }
}

/// <summary>
/// Merged watched-time intervals for one playback scope (work × playback session × user),
/// folded from progress heartbeats. Spans survive session close, so failed attempts keep
/// showing where the viewer actually spent time. GET /api/v1/playback-ranges.
/// </summary>
public sealed record PlaybackRangeResponse
{
    public required string WorkId { get; init; }
    public string? Title { get; init; }
    public required string Source { get; init; }
    public string? PlaybackSessionId { get; init; }
    public string? ExternalUserId { get; init; }
    public string? ExternalUserName { get; init; }
    public string? DeviceName { get; init; }

    /// <summary>Largest media duration reported for this scope, in 100 ns ticks.</summary>
    public long DurationTicks { get; init; }

    /// <summary>Latest playhead position, in 100 ns ticks.</summary>
    public long PositionTicks { get; init; }

    public string? LastSessionToken { get; init; }
    public string? LastReleaseId { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public IReadOnlyList<PlaybackRangeSpanResponse> Ranges { get; init; } = [];
}

/// <summary>A byte-space interval expressed as fractions [0..1] of the release payload.</summary>
public sealed record ByteRangeResponse
{
    public double Start { get; init; }
    public double End { get; init; }
}
