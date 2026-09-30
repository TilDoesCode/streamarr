using System.Collections.Concurrent;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>The real container family (<c>mp4</c>, <c>mkv</c>, …) of releases the server has opened, so predictions stop assuming it.</summary>
public sealed class ReleaseContainerStore(SessionManager? sessions = null)
{
    public const int MaxEntries = 20_000;

    private readonly ConcurrentDictionary<string, string> _known = new(StringComparer.Ordinal);

    /// <summary>Records a file extension (<c>mp4</c>) or an ffprobe format name (<c>mov,mp4,m4a,…</c>).</summary>
    public void Record(string? releaseId, string? container)
    {
        if (string.IsNullOrEmpty(releaseId) || Family(container) is not { } family)
            return;
        if (_known.Count >= MaxEntries && !_known.ContainsKey(releaseId))
            _known.Clear();
        _known[releaseId] = family;
    }

    public string? Get(string releaseId)
    {
        if (_known.TryGetValue(releaseId, out var family))
            return family;
        var session = sessions?.ListSessions().FirstOrDefault(s => string.Equals(s.Session.ReleaseId, releaseId, StringComparison.Ordinal));
        if (session is null)
            return null;
        Record(releaseId, session.File.Container);
        return _known.GetValueOrDefault(releaseId);
    }

    /// <summary>The ffprobe format name the planner expects for a container family.</summary>
    public static string FormatName(string family) => family switch
    {
        "mp4" => "mov,mp4,m4a,3gp,3g2,mj2",
        "mkv" => "matroska,webm",
        "ts" => "mpegts",
        _ => family,
    };

    internal static string? Family(string? container)
    {
        var value = container?.Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(value) || value.Length > 64)
            return null;
        return value switch
        {
            "mkv" or "webm" or "mk3d" => "mkv",
            "mp4" or "m4v" or "mov" => "mp4",
            "ts" or "m2ts" or "mts" => "ts",
            _ when value.Contains(',') => TranscodePlanner.ContainerFamily(value),
            _ => value,
        };
    }
}
