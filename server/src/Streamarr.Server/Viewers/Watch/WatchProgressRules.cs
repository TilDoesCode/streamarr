using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Watch;

public sealed record WatchReport
{
    public required string Event { get; init; }
    public required WorkKey Work { get; init; }
    public long PositionTicks { get; init; }
    public long? DurationTicks { get; init; }
    public string? PlaybackId { get; init; }
    public string? ReleaseId { get; init; }
    public string? StreamToken { get; init; }
    public string? Title { get; init; }
}

/// <summary>Jellyfin-compatible resume/played thresholds applied to one progress report.</summary>
public static class WatchProgressRules
{
    public static void Apply(ViewerWatchStateEntity state, WatchReport report, ViewerSettings settings, DateTimeOffset now)
    {
        state.LastPlayedAt = now;
        state.UpdatedAt = now;
        if (report.DurationTicks is > 0)
            state.DurationTicks = report.DurationTicks;
        if (!string.IsNullOrWhiteSpace(report.ReleaseId))
            state.LastReleaseId = report.ReleaseId;
        if (!string.IsNullOrWhiteSpace(report.Title))
            state.Title = report.Title;
        if (!string.IsNullOrWhiteSpace(report.PlaybackId))
            state.LastPlaybackId = report.PlaybackId;

        var position = Math.Max(0, report.PositionTicks);
        // A start report at 0 must not wipe a resume point before the player has seeked to it.
        if (report.Event == "start" && position == 0)
            return;

        if (state.DurationTicks is not { } duration || duration <= 0)
        {
            state.PositionTicks = position;
            return;
        }

        var percent = position * 100d / duration;
        if (percent >= settings.PlayedPercent)
        {
            MarkCompleted(state, report.PlaybackId, now);
            return;
        }

        var tooShort = duration < TimeSpan.FromSeconds(settings.MinResumeDurationSeconds).Ticks;
        state.PositionTicks = tooShort || percent < settings.MinResumePercent ? 0 : position;
    }

    public static void MarkCompleted(ViewerWatchStateEntity state, string? playbackId, DateTimeOffset now)
    {
        var alreadyCounted = playbackId is not null
            ? string.Equals(state.CountedPlaybackId, playbackId, StringComparison.Ordinal)
            : state.Played && state.PositionTicks == 0;
        if (!alreadyCounted)
        {
            state.PlayCount++;
            state.PlayedAt = now;
            state.CountedPlaybackId = playbackId;
        }
        state.Played = true;
        state.PositionTicks = 0;
    }
}
