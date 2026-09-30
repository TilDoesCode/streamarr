using Streamarr.Core.Tmdb;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>A movie or series card for search results and home rows (TMDB data only, no availability).</summary>
public sealed record CatalogItemDto
{
    /// <summary><c>tmdb-movie-{id}</c> or <c>tmdb-tv-{id}</c>.</summary>
    public required string WorkId { get; init; }

    /// <summary>"movie" or "series".</summary>
    public required string MediaType { get; init; }

    public required int TmdbId { get; init; }
    public required string Title { get; init; }
    public string? OriginalTitle { get; init; }
    public int? Year { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }

    /// <summary>TMDB vote average (0–10).</summary>
    public float? VoteAverage { get; init; }

    /// <summary>Vivid accent from the artwork (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade from the artwork (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); null until computed.</summary>
    public string? Tint2 { get; init; }

    /// <summary>Best known version by quality (from the last version lookup); null when none is known yet.</summary>
    public CatalogSpecDto? Spec { get; init; }
}

public sealed record CatalogSearchResponse
{
    public required IReadOnlyList<CatalogItemDto> Items { get; init; }
}

/// <summary>One home row.</summary>
public sealed record CatalogRowDto
{
    /// <summary>Stable id: <c>trending-movies</c>, <c>trending-series</c>, <c>popular-movies</c>, <c>popular-series</c>.</summary>
    public required string Id { get; init; }

    /// <summary>"trending" or "popular".</summary>
    public required string Kind { get; init; }

    /// <summary>"movie" or "series".</summary>
    public required string MediaType { get; init; }

    public required IReadOnlyList<CatalogItemDto> Items { get; init; }
}

public sealed record CatalogDiscoverResponse
{
    /// <summary>Rows in display order; rows without any title the viewer may watch are omitted.</summary>
    public required IReadOnlyList<CatalogRowDto> Rows { get; init; }
}

public sealed record CatalogMovieResponse
{
    public required string WorkId { get; init; }
    public required int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public required string Title { get; init; }
    public string? OriginalTitle { get; init; }
    public int? Year { get; init; }
    public string? Overview { get; init; }
    public string? Tagline { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    public int? RuntimeMinutes { get; init; }

    /// <summary>The TMDB certification the age gate uses (e.g. <c>PG-13</c>, <c>12</c>).</summary>
    public string? Certification { get; init; }

    public float? VoteAverage { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? LogoUrl { get; init; }
    public string? TrailerUrl { get; init; }
    /// <summary>Vivid accent from the artwork (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade from the artwork (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); null until computed.</summary>
    public string? Tint2 { get; init; }
    public IReadOnlyList<TmdbPerson> People { get; init; } = [];
    public required WatchStateResponse Watch { get; init; }
    public required ContentAccessResponse Access { get; init; }
}

public sealed record CatalogSeriesResponse
{
    public required string WorkId { get; init; }
    public required int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public required string Title { get; init; }
    public string? OriginalTitle { get; init; }
    public int? Year { get; init; }
    public string? Overview { get; init; }
    public string? Tagline { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];

    /// <summary>Typical episode runtime.</summary>
    public int? RuntimeMinutes { get; init; }

    public string? Certification { get; init; }
    public float? VoteAverage { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? LogoUrl { get; init; }
    public string? TrailerUrl { get; init; }
    /// <summary>Vivid accent from the artwork (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade from the artwork (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); null until computed.</summary>
    public string? Tint2 { get; init; }
    public IReadOnlyList<TmdbPerson> People { get; init; } = [];

    /// <summary>Regular seasons (specials excluded).</summary>
    public int SeasonCount { get; init; }

    /// <summary>Episodes of the regular seasons as TMDB lists them (may include announced ones).</summary>
    public int EpisodeCount { get; init; }

    public required IReadOnlyList<CatalogSeasonSummaryDto> Seasons { get; init; }
    public required SeriesWatchSummaryDto Watch { get; init; }
    public required ContentAccessResponse Access { get; init; }
}

public sealed record CatalogSeasonSummaryDto
{
    /// <summary><c>tmdb-tv-{id}-s{nn}</c>.</summary>
    public required string WorkId { get; init; }

    /// <summary>0 = specials.</summary>
    public required int SeasonNumber { get; init; }

    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    public int EpisodeCount { get; init; }
    public int PlayedCount { get; init; }
    public int InProgressCount { get; init; }
}

/// <summary>The viewer's progress through a series.</summary>
public sealed record SeriesWatchSummaryDto
{
    public int PlayedEpisodes { get; init; }
    public int InProgressEpisodes { get; init; }

    /// <summary>Episodes of the regular seasons (same basis as <see cref="CatalogSeriesResponse.EpisodeCount"/>).</summary>
    public int TotalEpisodes { get; init; }

    /// <summary>What "play" should start; null when everything aired has been watched.</summary>
    public CatalogNextEpisodeDto? NextEpisode { get; init; }

    /// <summary>True when TMDB could not be asked for the next episode.</summary>
    public bool Incomplete { get; init; }
}

public sealed record CatalogNextEpisodeDto
{
    public required string WorkId { get; init; }
    public required int SeasonNumber { get; init; }
    public required int EpisodeNumber { get; init; }
    public string? Title { get; init; }
    public string? AirDate { get; init; }
    public string? StillUrl { get; init; }
    public int? RuntimeMinutes { get; init; }
    public long PositionTicks { get; init; }
    public long? DurationTicks { get; init; }

    /// <summary><c>resume</c> (in progress), <c>next</c> (after the furthest played) or <c>start</c> (nothing watched yet).</summary>
    public required string Reason { get; init; }
}

public sealed record CatalogSeasonResponse
{
    public required string SeriesWorkId { get; init; }
    public required string SeriesTitle { get; init; }

    /// <summary><c>tmdb-tv-{id}-s{nn}</c>.</summary>
    public required string WorkId { get; init; }

    public required int TmdbId { get; init; }
    public required int SeasonNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    /// <summary>Vivid accent of the series (<c>#RRGGBB</c>, at least 3:1 against <c>#0A0C12</c>); null until computed.</summary>
    public string? Tint { get; init; }

    /// <summary>Deep shade of the series (<c>#RRGGBB</c>, white text reaches 4.5:1 on it); null until computed.</summary>
    public string? Tint2 { get; init; }
    public required IReadOnlyList<CatalogEpisodeDto> Episodes { get; init; }

    /// <summary>Present only with <c>?availability=true</c>.</summary>
    public CatalogAvailabilityDto? Availability { get; init; }
}

public sealed record CatalogEpisodeDto
{
    /// <summary><c>tmdb-tv-{id}-s{nn}e{nn}</c>.</summary>
    public required string WorkId { get; init; }

    public required int EpisodeNumber { get; init; }
    public required string Title { get; init; }
    public string? Overview { get; init; }
    public string? AirDate { get; init; }

    /// <summary>False for announced episodes whose air date is unknown or in the future.</summary>
    public bool Aired { get; init; }

    public int? RuntimeMinutes { get; init; }
    public string? StillUrl { get; init; }
    public float? VoteAverage { get; init; }
    public required WatchStateResponse Watch { get; init; }

    /// <summary>Playable versions (season packs included); null unless availability was requested and checked.</summary>
    public int? VersionCount { get; init; }

    /// <summary>Best known version by quality (from the last version lookup); null when none is known yet.</summary>
    public CatalogSpecDto? Spec { get; init; }
}

/// <summary>How fresh the version overlay is.</summary>
public sealed record CatalogAvailabilityDto
{
    public DateTimeOffset? CheckedAt { get; init; }
    public bool FromCache { get; init; }

    /// <summary>True when at least one indexer failed, so counts may be too low.</summary>
    public bool Incomplete { get; init; }

    /// <summary>Why the overlay is missing (<c>capacity_reached</c>, <c>search_temporarily_unavailable</c>); null on success.</summary>
    public string? Error { get; init; }
}

public sealed record CatalogVersionsResponse
{
    public required string WorkId { get; init; }

    /// <summary>"movie" or "episode".</summary>
    public required string MediaType { get; init; }

    /// <summary>Ranked best first; only versions the server would play (rejected and known-dead ones are left out).</summary>
    public required IReadOnlyList<VersionDto> Versions { get; init; }

    public required DateTimeOffset CheckedAt { get; init; }

    /// <summary>True when this list was not searched for this request (see <c>?refresh=true</c>).</summary>
    public bool FromCache { get; init; }

    /// <summary>True when at least one indexer failed; such lists are not cached.</summary>
    public bool Incomplete { get; init; }
}

/// <summary>One playable version, derived from the parsed release name plus server state; codes are lower-case, null = not stated.</summary>
public sealed record VersionDto
{
    public required string ReleaseId { get; init; }

    /// <summary>The raw release name.</summary>
    public required string Name { get; init; }

    /// <summary>Position in the default order, 1 = first. With a device profile: the best quality that plays without a server transcode first (see <c>qualityRank</c>).</summary>
    public required int Rank { get; init; }

    /// <summary>Position by quality and health alone, independent of the device (1 = best).</summary>
    public int QualityRank { get; init; }

    /// <summary>The version the server picks when the client does not choose one (rank 1); never set for a version the device cannot play.</summary>
    public bool Recommended { get; init; }

    /// <summary><c>2160p</c>, <c>1080p</c>, <c>720p</c>, <c>576p</c>, <c>540p</c>, <c>480p</c>, <c>360p</c> or <c>SD</c>.</summary>
    public string? Resolution { get; init; }

    /// <summary>e.g. <c>BluRay</c>, <c>Remux</c>, <c>WEB-DL</c>, <c>WEBRip</c>, <c>HDTV</c>, <c>DVD</c>.</summary>
    public string? Source { get; init; }

    /// <summary><c>h264</c>, <c>hevc</c>, <c>av1</c>, <c>vc1</c>, <c>mpeg2</c>, <c>xvid</c> or <c>divx</c>.</summary>
    public string? VideoCodec { get; init; }

    /// <summary>Stated in the name, or 10 when it names an HDR format (HDR needs at least 10 bits).</summary>
    public int? BitDepth { get; init; }

    /// <summary>Headline HDR format: <c>dolbyvision</c>, <c>hdr10plus</c>, <c>hdr10</c> or <c>hlg</c>; null = SDR or not stated.</summary>
    public string? Hdr { get; init; }

    /// <summary>Every HDR format named, headline first (Dolby Vision releases often carry an <c>hdr10</c> base layer).</summary>
    public IReadOnlyList<string> HdrFormats { get; init; } = [];

    /// <summary><c>truehd</c>, <c>dts-hd-ma</c>, <c>dts-hd</c>, <c>dts-x</c>, <c>dts-es</c>, <c>dts</c>, <c>eac3</c>, <c>ac3</c>, <c>flac</c>, <c>opus</c>, <c>aac</c>, <c>mp3</c> or <c>pcm</c>.</summary>
    public string? AudioCodec { get; init; }

    /// <summary>Layout such as <c>7.1</c>, <c>5.1</c>, <c>2.0</c>.</summary>
    public string? AudioChannels { get; init; }

    public bool Atmos { get; init; }

    /// <summary>Spoken languages (ISO 639-1) the name mentions.</summary>
    public IReadOnlyList<string> Languages { get; init; } = [];

    /// <summary>MULTi / dual-audio marker present.</summary>
    public bool MultiLanguage { get; init; }

    /// <summary><c>subbed</c>, <c>multi</c>, <c>hardcoded</c>; empty = the name says nothing about subtitles.</summary>
    public IReadOnlyList<string> SubtitleHints { get; init; } = [];

    /// <summary>Subtitle languages (ISO 639-1) the name mentions.</summary>
    public IReadOnlyList<string> SubtitleLanguages { get; init; } = [];

    public string? Edition { get; init; }
    public string? ReleaseGroup { get; init; }
    public bool Proper { get; init; }
    public bool Repack { get; init; }

    /// <summary>A whole-season release; <see cref="SizeBytes"/> is the full pack.</summary>
    public bool SeasonPack { get; init; }

    /// <summary>Size the indexer reports.</summary>
    public long SizeBytes { get; init; }

    /// <summary>Size ÷ TMDB runtime (per episode for season packs); null when the runtime is unknown.</summary>
    public int? EstimatedBitrateKbps { get; init; }

    /// <summary>Days since the release was posted.</summary>
    public int AgeDays { get; init; }

    /// <summary><c>unknown</c> (not checked yet), <c>ready</c> or <c>degraded</c> (last resolve found missing articles).</summary>
    public required string Health { get; init; }

    /// <summary><c>ready</c> or <c>downloading</c> when a pre-download of this version exists for the viewer; else null.</summary>
    public string? Local { get; init; }

    /// <summary>Prediction only (<c>direct</c>, <c>remux</c>, <c>transcode</c>, <c>unknown</c>; <c>vlc</c> when the request sent <c>vlcAvailable=true</c>) from the name and the sent device profile; the server decides at playback.</summary>
    public string? PredictedMethod { get; init; }

    /// <summary>Why, plus every assumption the prediction made (e.g. <c>container_assumed</c>).</summary>
    public IReadOnlyList<PredictionReasonDto>? PredictionReasons { get; init; }
}

public sealed record PredictionReasonDto
{
    public required string Code { get; init; }
    public IReadOnlyDictionary<string, string>? Params { get; init; }
}
