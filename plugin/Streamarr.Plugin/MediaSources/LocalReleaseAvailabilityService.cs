using System.Globalization;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.MediaSources;

public enum LocalReleaseState
{
    Remote = 0,
    Downloading = 1,
    Ready = 2,
}

public readonly record struct LocalReleaseKey(string WorkId, string ReleaseId);

public sealed class LocalReleaseAvailabilitySnapshot
{
    private const int MaxEntriesPerWork = StreamarrPayloadBounds.MaxTransientLocalReleasesPerWork;

    public static LocalReleaseAvailabilitySnapshot Empty { get; } = new([]);

    private sealed record LocalEntry(LocalReleaseState State, ReleaseDto? Release, int Sequence);

    private readonly IReadOnlyDictionary<LocalReleaseKey, LocalEntry> _entries;

    internal LocalReleaseAvailabilitySnapshot(IEnumerable<LocalReleaseAvailabilityDto> releases)
    {
        var entries = new Dictionary<LocalReleaseKey, LocalEntry>();
        var countsByWork = new Dictionary<string, int>(StringComparer.Ordinal);
        var sequence = 0;
        foreach (var release in releases)
        {
            if (string.IsNullOrWhiteSpace(release.WorkId)
                || string.IsNullOrWhiteSpace(release.ReleaseId))
            {
                continue;
            }

            var state = release.State switch
            {
                "ready" => LocalReleaseState.Ready,
                "downloading" => LocalReleaseState.Downloading,
                _ => LocalReleaseState.Remote,
            };
            if (state == LocalReleaseState.Remote)
                continue;

            var key = new LocalReleaseKey(release.WorkId, release.ReleaseId);
            var metadata = release.Release is { } candidate
                           && string.Equals(candidate.ReleaseId, release.ReleaseId, StringComparison.Ordinal)
                ? candidate
                : null;
            if (entries.TryGetValue(key, out var current))
            {
                entries[key] = current with
                {
                    State = state > current.State ? state : current.State,
                    Release = current.Release ?? metadata,
                };
                continue;
            }

            var count = countsByWork.GetValueOrDefault(release.WorkId);
            if (count >= MaxEntriesPerWork)
                continue;

            countsByWork[release.WorkId] = count + 1;
            entries[key] = new LocalEntry(state, metadata, sequence++);
        }

        _entries = entries;
    }

    public LocalReleaseState GetState(string workId, string releaseId)
        => _entries.TryGetValue(new LocalReleaseKey(workId, releaseId), out var entry)
            ? entry.State
            : LocalReleaseState.Remote;

    internal IReadOnlyList<ReleaseDto> MergeReleases(
        string workId,
        IReadOnlyList<ReleaseDto> persistedReleases)
    {
        var merged = persistedReleases
            .Take(StreamarrPayloadBounds.MaxReleasesPerWork)
            .ToList();
        var seen = merged
            .Select(release => release.ReleaseId)
            .ToHashSet(StringComparer.Ordinal);
        var extras = 0;

        foreach (var local in _entries
                     .Where(pair => string.Equals(pair.Key.WorkId, workId, StringComparison.Ordinal)
                                    && pair.Value.Release is not null)
                     .OrderBy(pair => pair.Value.Sequence))
        {
            if (!seen.Add(local.Key.ReleaseId))
                continue;

            if (extras >= StreamarrPayloadBounds.MaxTransientLocalReleasesPerWork)
                break;
            merged.Add(local.Value.Release!);
            extras++;
        }

        return merged;
    }

    internal IReadOnlySet<string> GetTrustedReleaseIds(string workId)
        => _entries.Keys
            .Where(key => string.Equals(key.WorkId, workId, StringComparison.Ordinal))
            .Select(key => key.ReleaseId)
            .ToHashSet(StringComparer.Ordinal);
}

public sealed class LocalReleaseAvailabilityService(
    EphemeralReleaseStore store,
    StreamarrApiClient api,
    ILogger<LocalReleaseAvailabilityService> logger)
{
    internal static readonly TimeSpan QueryTimeout = TimeSpan.FromSeconds(2);

    public async Task<LocalReleaseAvailabilitySnapshot> GetForItemsAsync(
        IEnumerable<Guid> itemIds,
        Guid userId,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(itemIds);
        if (userId == Guid.Empty)
            return LocalReleaseAvailabilitySnapshot.Empty;

        var workIds = itemIds
            .Select(itemId => store.Peek(itemId)?.Work.WorkId)
            .Where(workId => !string.IsNullOrWhiteSpace(workId))
            .Cast<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (workIds.Length == 0)
            return LocalReleaseAvailabilitySnapshot.Empty;

        var requesterId = userId.ToString("D", CultureInfo.InvariantCulture);
        var tasks = workIds
            .Chunk(StreamarrPayloadBounds.MaxLocalAvailabilityWorkIds)
            .Select(batch => FetchBatchAsync(batch, requesterId, ct))
            .ToArray();
        var batches = await Task.WhenAll(tasks).ConfigureAwait(false);
        return new LocalReleaseAvailabilitySnapshot(batches.SelectMany(batch => batch));
    }

    private async Task<IReadOnlyList<LocalReleaseAvailabilityDto>> FetchBatchAsync(
        IReadOnlyList<string> workIds,
        string requestedById,
        CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(QueryTimeout);
        try
        {
            var response = await api.GetLocalReleaseAvailabilityAsync(
                    workIds,
                    "jellyfin",
                    requestedById,
                    timeout.Token)
                .ConfigureAwait(false);
            if (response is null)
                return [];

            var requested = workIds.ToHashSet(StringComparer.Ordinal);
            return response.Releases
                .Where(release => requested.Contains(release.WorkId))
                .ToArray();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(
                ex,
                "Could not read local Streamarr release availability ({FailureType})",
                ex.GetType().Name);
            return [];
        }
    }
}
