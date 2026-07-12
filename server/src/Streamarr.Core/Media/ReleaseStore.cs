using System.Collections.Concurrent;

namespace Streamarr.Core.Media;

/// <summary>A release known to the server, keyed to the work it belongs to.</summary>
public sealed record RegisteredRelease
{
    public required string WorkId { get; init; }
    public required Release Release { get; init; }
}

/// <summary>
/// Server-side registry mapping releaseId → release (incl. its NZB location, which
/// never leaves the server). Populated by /search in M2; in M1 it is fed directly
/// by tests and tooling. /resolve looks releases up here (BRIEF §6.2).
/// </summary>
public interface IReleaseStore
{
    void Register(string workId, Release release);

    RegisteredRelease? Get(string releaseId);

    /// <summary>
    /// The next-best ranked, non-rejected release of the same work — surfaced as
    /// <c>suggestedFallbackReleaseId</c> when a release resolves dead.
    /// </summary>
    RegisteredRelease? FindFallback(string workId, string excludeReleaseId);
}

public sealed class InMemoryReleaseStore : IReleaseStore
{
    private readonly ConcurrentDictionary<string, RegisteredRelease> _releases = new(StringComparer.Ordinal);

    public void Register(string workId, Release release)
        => _releases[release.ReleaseId] = new RegisteredRelease { WorkId = workId, Release = release };

    public RegisteredRelease? Get(string releaseId)
        => _releases.GetValueOrDefault(releaseId);

    public RegisteredRelease? FindFallback(string workId, string excludeReleaseId)
        => _releases.Values
            .Where(r => r.WorkId == workId
                        && r.Release.ReleaseId != excludeReleaseId
                        && !r.Release.Rejected
                        && r.Release.Health != ReleaseHealth.Dead)
            .MaxBy(r => r.Release.Score);
}
