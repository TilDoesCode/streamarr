using System.Collections.Concurrent;

namespace Streamarr.Server.Services;

/// <summary>The media file a release resolved to for a work (name, exact decoded size, container).</summary>
public sealed record ResolvedFileInfo(string FileName, long SizeBytes, string Container, DateTimeOffset RecordedAt);

/// <summary>
/// Remembers the exact file of every (release, work) a stream session opened, so device-download candidates know the exact size
/// of an episode inside a pack without another resolve. In memory and bounded; a restart forgets it.
/// </summary>
public sealed class ResolvedFileStore(TimeProvider? time = null, int maxEntries = ResolvedFileStore.DefaultMaxEntries)
{
    public const int DefaultMaxEntries = 20_000;

    private readonly ConcurrentDictionary<(string ReleaseId, string WorkId), ResolvedFileInfo> _files = new();
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public void Record(string releaseId, string workId, string fileName, long sizeBytes, string container)
    {
        if (string.IsNullOrEmpty(releaseId) || string.IsNullOrEmpty(workId) || sizeBytes <= 0)
            return;
        _files[(releaseId, workId)] = new ResolvedFileInfo(fileName, sizeBytes, container, _time.GetUtcNow());
        if (_files.Count <= maxEntries)
            return;
        foreach (var stale in _files.OrderBy(f => f.Value.RecordedAt).Take(_files.Count - maxEntries / 10 * 9).Select(f => f.Key).ToList())
            _files.TryRemove(stale, out _);
    }

    public ResolvedFileInfo? Get(string releaseId, string workId) => _files.GetValueOrDefault((releaseId, workId));
}
