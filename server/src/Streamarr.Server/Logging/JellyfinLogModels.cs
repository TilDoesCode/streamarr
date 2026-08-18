namespace Streamarr.Server.Logging;

/// <summary>
/// Result states returned by the optional Jellyfin log source. Remote and
/// configuration failures are data, not exceptions, so they cannot prevent the
/// Core from starting or serving its own logs.
/// </summary>
public enum JellyfinLogFetchStatus
{
    Disabled,
    Available,
    Misconfigured,
    Unauthorized,
    Forbidden,
    TimedOut,
    TooLarge,
    InvalidResponse,
    Unavailable,
}

public sealed record JellyfinLogEntry(
    DateTimeOffset? Timestamp,
    string Level,
    string Message);

public sealed record JellyfinLogSnapshot(
    JellyfinLogFetchStatus Status,
    DateTimeOffset CheckedAtUtc,
    string? SourceFileName,
    DateTimeOffset? SourceFileModifiedAtUtc,
    IReadOnlyList<JellyfinLogEntry> Entries,
    bool IsTruncated,
    string? Detail)
{
    public static JellyfinLogSnapshot Failure(
        JellyfinLogFetchStatus status,
        DateTimeOffset checkedAtUtc,
        string detail)
        => new(status, checkedAtUtc, null, null, [], false, detail);
}

/// <summary>
/// Lazily retrieves a bounded, sanitized view of relevant Jellyfin server logs.
/// </summary>
public interface IJellyfinLogSource
{
    ValueTask<JellyfinLogSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default);
}
