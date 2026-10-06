using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Streamarr.DevWorld.Faults;

public sealed class PlaybackRecord
{
    public required string PlaybackId { get; init; }
    public string? WorkId { get; set; }
    public string? Viewer { get; set; }
    public string? Method { get; set; }
    public string? Engine { get; set; }
    public string? State { get; set; }
    public int Revision { get; set; }
    /// <summary>The version that plays (from the answer's <c>version</c>); a failed start has none.</summary>
    public string? ReleaseId { get; set; }
    /// <summary>A failed start's error code and the release it names (e.g. the requested one of <c>release_not_found</c>).</summary>
    public string? Error { get; set; }
    public string? ErrorReleaseId { get; set; }
    public string? HlsToken { get; set; }
    public string? StreamToken { get; set; }
    public HashSet<string> Tokens { get; } = [];
    public DateTimeOffset LastSeen { get; set; }
    public DateTimeOffset? ReadyAt { get; set; }

    public object ToSummary() => new
    {
        playbackId = PlaybackId,
        workId = WorkId,
        viewer = Viewer,
        method = Method,
        engine = Engine,
        state = State,
        releaseId = ReleaseId,
        error = Error,
        errorReleaseId = ErrorReleaseId,
        hlsToken = HlsToken,
        streamToken = StreamToken,
        revision = Revision,
        lastSeen = LastSeen,
        readyAt = ReadyAt,
    };
}

/// <summary>H2: playbackId → work, viewer and capability tokens, learned from the playback API answers and the resolve hook.</summary>
public sealed partial class PlaybackMap(TimeProvider time)
{
    private readonly ConcurrentDictionary<string, PlaybackRecord> _byId = new();
    private readonly ConcurrentDictionary<string, string> _byToken = new();
    private readonly ConcurrentDictionary<string, (string WorkId, string Viewer)> _resolved = new();
    private readonly ConcurrentDictionary<string, double[]> _segments = new();

    public IReadOnlyList<PlaybackRecord> List() => _byId.Values.OrderByDescending(p => p.LastSeen).ToList();

    public PlaybackRecord? ById(string? id) => id is not null && _byId.TryGetValue(id, out var p) ? p : null;

    public PlaybackRecord? ByToken(string? token) => token is not null && _byToken.TryGetValue(token, out var id) ? ById(id) : null;

    /// <summary>Learns from a PlaybackResponse JSON (start, poll or switch answer).</summary>
    public PlaybackRecord? Learn(JsonNode? root, string? viewer)
    {
        if (root is not JsonObject obj || obj["playbackId"]?.GetValue<string>() is not { } id)
            return null;
        var record = _byId.GetOrAdd(id, _ => new PlaybackRecord { PlaybackId = id });
        lock (record)
        {
            record.WorkId = Str(obj, "workId") ?? record.WorkId;
            record.Viewer ??= viewer;
            record.State = Str(obj, "state") ?? record.State;
            record.Method = Str(obj, "method") ?? record.Method;
            record.Engine = Str(obj, "engine") ?? record.Engine;
            record.Revision = obj["revision"] is JsonValue rev && rev.TryGetValue<int>(out var r) ? r : record.Revision;
            record.ReleaseId = obj["version"]?["releaseId"]?.GetValue<string>() ?? record.ReleaseId;
            if (obj["error"] is JsonObject error)
            {
                record.Error = Str(error, "code");
                record.ErrorReleaseId = error["params"] is JsonObject parameters ? Str(parameters, "releaseId") : null;
            }
            record.LastSeen = time.GetUtcNow();
            if (Str(obj, "url") is { } url)
            {
                if (HlsRegex().Match(url) is { Success: true } h)
                    Remember(record, record.HlsToken = h.Groups[1].Value);
                else if (StreamRegex().Match(url) is { Success: true } s)
                    Remember(record, record.StreamToken = s.Groups[1].Value);
            }
            if (Str(obj, "streamToken") is { } token)
                Remember(record, record.StreamToken = token);
            if (record.State == "ready")
                record.ReadyAt ??= time.GetUtcNow();
        }
        return record;
    }

    /// <summary>H4: the stream capability a resolve produced for a viewer and work.</summary>
    public void LearnResolve(string streamToken, string workId, string viewer) => _resolved[streamToken] = (workId, viewer);

    public (string WorkId, string Viewer)? Resolved(string token) => _resolved.TryGetValue(token, out var r) ? r : null;

    public void LearnSegments(string hlsToken, string playlist)
    {
        var durations = new List<double>();
        foreach (var line in playlist.Split('\n'))
        {
            if (line.StartsWith("#EXTINF:", StringComparison.Ordinal)
                && double.TryParse(line[8..].Split(',')[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                durations.Add(d);
        }
        if (durations.Count > 0)
            _segments[hlsToken] = [.. durations];
    }

    /// <summary>Media time where segment <paramref name="index"/> starts; null when the playlist was not seen.</summary>
    public double? SegmentStart(string hlsToken, int index)
        => _segments.TryGetValue(hlsToken, out var d) ? d.Take(Math.Min(index, d.Length)).Sum() + Math.Max(0, index - d.Length) * (d.Length > 0 ? d[^1] : 0) : null;

    private void Remember(PlaybackRecord record, string token)
    {
        record.Tokens.Add(token);
        _byToken[token] = record.PlaybackId;
    }

    private static string? Str(JsonObject obj, string name) => obj[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    [GeneratedRegex(@"/api/v1/transcode/([^/]+)/")]
    private static partial Regex HlsRegex();

    [GeneratedRegex(@"/api/v1/stream/([^/?]+)")]
    private static partial Regex StreamRegex();
}
