using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Services;

/// <summary>One watched span in ticks, attributed to the capability token it was watched through.</summary>
public sealed record PlaybackRangeSpan
{
    [JsonPropertyName("s")]
    public long StartTicks { get; init; }

    [JsonPropertyName("e")]
    public long EndTicks { get; init; }

    [JsonPropertyName("t")]
    public string? SessionToken { get; init; }

    [JsonPropertyName("r")]
    public string? ReleaseId { get; init; }
}

/// <summary>
/// Folds playback heartbeats into merged watched-time intervals at ingest time. Jellyfin
/// reports position roughly once per second while actually playing, so an interval
/// [previous, current] is credited only when the position advanced at plausible playback
/// speed relative to wall time — seeks, pauses, release switches, and stale anchors merely
/// re-anchor. Runs inside the <see cref="WatchEventService"/> write gate; anchors are
/// in-memory (a restart just re-anchors on the next heartbeat).
/// </summary>
public sealed class PlaybackRangeRecorder
{
    /// <summary>Reject spans faster than 3× realtime (seek); the slack tolerates report jitter.</summary>
    internal const double MaxPlaybackSpeed = 3d;
    internal static readonly TimeSpan SeekSlack = TimeSpan.FromSeconds(20);
    internal static readonly TimeSpan MaxHeartbeatGap = TimeSpan.FromMinutes(2);
    internal static readonly TimeSpan MergeGap = TimeSpan.FromSeconds(5);
    internal const int MaxSpansPerScope = 512;
    internal const int MaxRetainedScopes = 500;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record Anchor(long PositionTicks, DateTimeOffset At, string Token, string ReleaseId);

    private readonly Dictionary<string, Anchor> _anchors = new(StringComparer.Ordinal);

    /// <summary>Called by WatchEventService inside its write gate, sharing its DbContext.</summary>
    public async Task RecordAsync(
        StreamarrDbContext db,
        WatchEventWrite write,
        string workId,
        string title,
        DateTimeOffset receivedAt,
        CancellationToken ct)
    {
        if (write.PositionTicks is not { } position || position < 0)
            return;
        var scopeWork = string.IsNullOrWhiteSpace(workId) ? write.ReleaseId : workId;
        if (string.IsNullOrWhiteSpace(scopeWork))
            return;

        var playback = string.IsNullOrWhiteSpace(write.PlaybackSessionId)
            ? $"user:{write.ExternalUserId ?? "unknown"}"
            : write.PlaybackSessionId;
        var scopeKey = $"{write.Source ?? "unknown"}|{playback}|{scopeWork}";
        var token = write.SessionToken ?? string.Empty;
        var releaseId = write.ReleaseId;

        PlaybackRangeSpan? accepted = null;
        if (write.Event is "progress" or "stop" && _anchors.TryGetValue(scopeKey, out var anchor))
        {
            var wallDelta = receivedAt - anchor.At;
            var positionDelta = position - anchor.PositionTicks;
            var sameStream = token.Length > 0 || anchor.Token.Length > 0
                ? string.Equals(anchor.Token, token, StringComparison.Ordinal)
                : string.Equals(anchor.ReleaseId, releaseId, StringComparison.Ordinal);
            var plausible = positionDelta > 0
                && wallDelta > TimeSpan.Zero
                && wallDelta <= MaxHeartbeatGap
                && positionDelta <= (long)(wallDelta.Ticks * MaxPlaybackSpeed) + SeekSlack.Ticks;
            if (sameStream && plausible)
            {
                accepted = new PlaybackRangeSpan
                {
                    StartTicks = anchor.PositionTicks,
                    EndTicks = position,
                    SessionToken = token.Length > 0 ? token : null,
                    ReleaseId = releaseId,
                };
            }
        }

        if (write.Event == "stop")
            _anchors.Remove(scopeKey);
        else
            _anchors[scopeKey] = new Anchor(position, receivedAt, token, releaseId);

        var row = await db.PlaybackRanges.FirstOrDefaultAsync(r => r.ScopeKey == scopeKey, ct);
        if (row is null)
        {
            if (accepted is null && write.Event != "start")
                return;
            row = new PlaybackRangeEntity { ScopeKey = scopeKey, StartedAt = receivedAt };
            db.PlaybackRanges.Add(row);
        }

        row.WorkId = scopeWork;
        if (!string.IsNullOrWhiteSpace(title))
            row.Title = title;
        row.Source = write.Source ?? string.Empty;
        row.PlaybackSessionId = write.PlaybackSessionId ?? string.Empty;
        row.ExternalUserId = write.ExternalUserId ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(write.ExternalUserName))
            row.ExternalUserName = write.ExternalUserName;
        if (!string.IsNullOrWhiteSpace(write.DeviceName))
            row.DeviceName = write.DeviceName;
        row.DurationTicks = Math.Max(row.DurationTicks, write.DurationTicks ?? 0);
        row.PositionTicks = position;
        if (token.Length > 0)
            row.LastSessionToken = token;
        row.LastReleaseId = releaseId;
        row.UpdatedAt = receivedAt;

        if (accepted is not null)
        {
            var spans = Deserialize(row.RangesJson);
            spans.Add(accepted);
            row.RangesJson = JsonSerializer.Serialize(Normalize(spans), JsonOptions);
        }

        await db.SaveChangesAsync(ct);
        await PruneAsync(db, ct);
    }

    public static IReadOnlyList<PlaybackRangeSpan> Parse(string rangesJson)
        => Deserialize(rangesJson);

    private static List<PlaybackRangeSpan> Deserialize(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<PlaybackRangeSpan>>(json, JsonOptions) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>Sort, merge same-token neighbours (gap ≤ 5 s), and bound the span count.</summary>
    internal static List<PlaybackRangeSpan> Normalize(List<PlaybackRangeSpan> spans)
    {
        var ordered = spans
            .Where(span => span.EndTicks > span.StartTicks)
            .OrderBy(span => span.StartTicks)
            .ToList();
        var merged = new List<PlaybackRangeSpan>(ordered.Count);
        foreach (var span in ordered)
        {
            var last = merged.Count > 0 ? merged[^1] : null;
            if (last is not null
                && string.Equals(last.SessionToken, span.SessionToken, StringComparison.Ordinal)
                && span.StartTicks <= last.EndTicks + MergeGap.Ticks)
            {
                merged[^1] = last with { EndTicks = Math.Max(last.EndTicks, span.EndTicks) };
            }
            else
            {
                merged.Add(span);
            }
        }

        // Pathological span counts (constant tiny seeks) collapse by joining the smallest gaps.
        while (merged.Count > MaxSpansPerScope)
        {
            var victim = 1;
            var smallest = long.MaxValue;
            for (var i = 1; i < merged.Count; i++)
            {
                var gap = merged[i].StartTicks - merged[i - 1].EndTicks;
                if (gap < smallest)
                {
                    smallest = gap;
                    victim = i;
                }
            }
            merged[victim - 1] = merged[victim - 1] with
            {
                EndTicks = Math.Max(merged[victim - 1].EndTicks, merged[victim].EndTicks),
            };
            merged.RemoveAt(victim);
        }
        return merged;
    }

    private async Task PruneAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var overflow = await db.PlaybackRanges.CountAsync(ct) - MaxRetainedScopes;
        if (overflow <= 0)
            return;
        // SQLite cannot ORDER BY DateTimeOffset in LINQ; the table is bounded, so sort in memory.
        var victims = (await db.PlaybackRanges.ToListAsync(ct))
            .OrderBy(r => r.UpdatedAt).ThenBy(r => r.Id)
            .Take(overflow)
            .ToList();
        db.PlaybackRanges.RemoveRange(victims);
        await db.SaveChangesAsync(ct);
    }
}
