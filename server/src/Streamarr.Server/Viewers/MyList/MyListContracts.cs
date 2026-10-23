using Streamarr.Server.Viewers.Artwork;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Viewers.MyList;

/// <summary>Derived status of a list entry.</summary>
public static class MyListStatus
{
    /// <summary>Nothing played yet.</summary>
    public const string WantToWatch = "want_to_watch";

    /// <summary>Started, with a playable episode (or the movie's resume point) waiting.</summary>
    public const string Watching = "watching";

    /// <summary>Every aired, available episode is played and the series continues (or the next episode has no usable release yet).</summary>
    public const string CaughtUp = "caught_up";

    /// <summary>Movie played, season fully played, or series ended and fully played.</summary>
    public const string Watched = "watched";

    public static readonly IReadOnlyList<string> All = [WantToWatch, Watching, CaughtUp, Watched];
}

public sealed record MyListItemDto
{
    /// <summary>Movie (<c>tmdb-movie-603</c>), series (<c>tmdb-tv-1396</c>) or season (<c>tmdb-tv-1396-s02</c>) work id.</summary>
    public required string WorkId { get; init; }

    /// <summary><c>movie</c>, <c>series</c> or <c>season</c>.</summary>
    public required string Kind { get; init; }

    public required int TmdbId { get; init; }
    public string? SeriesWorkId { get; init; }
    public int? SeasonNumber { get; init; }

    /// <summary>Movie or series title; a season's own title (e.g. "Season 2") with the series in <see cref="SeriesTitle"/>.</summary>
    public required string Title { get; init; }

    public string? SeriesTitle { get; init; }
    public int? Year { get; init; }
    public string? PosterUrl { get; init; }
    public ArtworkSizesDto? PosterSizes => ArtworkSizes.Poster(PosterUrl);
    public string? BackdropUrl { get; init; }
    public ArtworkSizesDto? BackdropSizes => ArtworkSizes.Backdrop(BackdropUrl);

    /// <summary>Vivid accent of the title (<c>#RRGGBB</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade of the title (<c>#RRGGBB</c>); null until computed.</summary>
    public string? Tint2 { get; init; }

    /// <summary><c>want_to_watch</c>, <c>watching</c>, <c>caught_up</c> or <c>watched</c>.</summary>
    public required string Status { get; init; }

    /// <summary><c>manual</c> (added by the viewer) or <c>auto</c> (a series the viewer started).</summary>
    public required string Source { get; init; }

    /// <summary>A new episode with usable releases appeared since the viewer was caught up; cleared by <c>seen</c> or by playing it.</summary>
    public bool IsNew { get; init; }

    public DateTimeOffset? NewAvailableSince { get; init; }

    /// <summary>The episode that made the entry new.</summary>
    public string? NewEpisodeWorkId { get; init; }

    /// <summary>Played regular episodes in scope (series: all seasons, season: that season); null for movies.</summary>
    public int? PlayedEpisodes { get; init; }

    /// <summary>Aired regular episodes in scope; null for movies.</summary>
    public int? TotalEpisodes { get; init; }

    /// <summary>The episode to play now (<c>resume</c>, <c>next</c> or <c>start</c>); <c>available</c> false = aired but no usable release yet.</summary>
    public CatalogNextEpisodeDto? NextEpisode { get; init; }

    /// <summary>The next episode that has not aired yet (reason <c>upcoming</c>), when the viewer is caught up.</summary>
    public CatalogNextEpisodeDto? UpcomingEpisode { get; init; }

    /// <summary>Movie resume position (0 = none).</summary>
    public long PositionTicks { get; init; }

    public long? DurationTicks { get; init; }

    /// <summary>Series only: TMDB lists it as ended or canceled.</summary>
    public bool Ended { get; init; }

    public required DateTimeOffset AddedAt { get; init; }

    /// <summary>Most recent playback in scope; null when nothing was played.</summary>
    public DateTimeOffset? LastActivityAt { get; init; }

    /// <summary>TMDB could not be reached for this entry; status and progress come from local watch state only.</summary>
    public bool Incomplete { get; init; }
}

public sealed record MyListResponse
{
    public required IReadOnlyList<MyListItemDto> Items { get; init; }

    /// <summary>Entries matching the filter (before paging).</summary>
    public required int Total { get; init; }

    /// <summary>Some entries could not be checked against TMDB.</summary>
    public required bool Incomplete { get; init; }
}

public sealed record MyListSummaryResponse
{
    /// <summary>Entries flagged new (for a badge).</summary>
    public required int NewCount { get; init; }

    public required int Total { get; init; }
    public required int WantToWatch { get; init; }
    public required int Watching { get; init; }
    public required int CaughtUp { get; init; }
    public required int Watched { get; init; }
}

public sealed record MyListEntryStatusResponse
{
    public required string WorkId { get; init; }

    /// <summary>The work itself is on the list (not removed).</summary>
    public required bool OnList { get; init; }

    /// <summary>The entry when <see cref="OnList"/>.</summary>
    public MyListItemDto? Item { get; init; }

    /// <summary>Seasons only: the whole series is on the list.</summary>
    public bool? SeriesOnList { get; init; }
}

public sealed record MyListAddRequest
{
    /// <summary>Optional status set by the viewer: <c>want_to_watch</c> or <c>watched</c>; it holds until the next playback. Null keeps the derived status.</summary>
    public string? Status { get; init; }
}
