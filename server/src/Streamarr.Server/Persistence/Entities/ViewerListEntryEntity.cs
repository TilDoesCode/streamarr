namespace Streamarr.Server.Persistence.Entities;

/// <summary>One title on a viewer's list ("My List"): a movie, series or season, added by the viewer or automatically when a series was started.</summary>
public sealed class ViewerListEntryEntity
{
    public long Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;
    public string WorkId { get; set; } = string.Empty;

    /// <summary><c>movie</c>, <c>series</c> or <c>season</c>.</summary>
    public string Kind { get; set; } = string.Empty;
    public int TmdbId { get; set; }

    /// <summary>The series work id for series and seasons; null for movies.</summary>
    public string? SeriesWorkId { get; set; }
    public int? SeasonNumber { get; set; }

    /// <summary><c>manual</c> (added by the viewer) or <c>auto</c> (a started series).</summary>
    public string Source { get; set; } = string.Empty;

    /// <summary>Removed by the viewer; kept as a tombstone so a started series is not added again automatically.</summary>
    public bool Dismissed { get; set; }

    /// <summary>Viewer-set status (<c>want_to_watch</c> or <c>watched</c>) that wins until the next playback after <see cref="StatusOverrideAt"/>.</summary>
    public string? StatusOverride { get; set; }
    public DateTimeOffset? StatusOverrideAt { get; set; }

    /// <summary>When the availability monitor found a new, playable episode (<see cref="NewEpisodeWorkId"/>); null when nothing is new.</summary>
    public DateTimeOffset? NewAvailableSince { get; set; }
    public string? NewEpisodeWorkId { get; set; }

    /// <summary>The latest episode the viewer was told about; the monitor never flags it (or an earlier one) again.</summary>
    public string? LastNotifiedEpisodeWorkId { get; set; }

    /// <summary>The episode the monitor saw the caught-up viewer waiting for (not aired or no usable release yet).</summary>
    public string? PendingEpisodeWorkId { get; set; }

    /// <summary>The viewer last cleared the new flag.</summary>
    public DateTimeOffset? SeenAt { get; set; }

    /// <summary>The monitor found the title fully watched and ended; it is re-checked only rarely after this.</summary>
    public DateTimeOffset? FinishedCheckedAt { get; set; }

    public DateTimeOffset AddedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
