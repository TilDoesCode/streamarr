using System.Text.Json.Serialization;

namespace Streamarr.Plugin.Api;

// These DTOs mirror the Core Server's public contracts (server/.../Contracts). They are
// pure transport records — the plugin does no domain logic on them (BRIEF §3.1 rule 3).
// JSON is camelCase over the wire; property names here are matched case-insensitively.

/// <summary>Response of <c>GET /api/v1/health</c>.</summary>
public sealed record HealthResponse
{
    public string? Status { get; init; }
    public string? Version { get; init; }
    public IReadOnlyList<ReachabilityStatus> Indexers { get; init; } = [];
    public IReadOnlyList<ReachabilityStatus> Providers { get; init; } = [];
}

public sealed record ReachabilityStatus
{
    public string? Name { get; init; }
    public bool Reachable { get; init; }
    public double? LatencyMs { get; init; }
    public string? Error { get; init; }
}

/// <summary>Authenticated response of <c>GET /api/v1/caps</c>.</summary>
public sealed record CapsResponse
{
    public IReadOnlyList<string> MediaTypes { get; init; } = [];
    public IReadOnlyList<CapsCategory> Categories { get; init; } = [];
    public IReadOnlyList<CapsProvider> Providers { get; init; } = [];
}

public sealed record CapsCategory
{
    public int Id { get; init; }
    public string Name { get; init; } = string.Empty;
}

public sealed record CapsProvider
{
    public string Name { get; init; } = string.Empty;
    public int Priority { get; init; }
    public bool Enabled { get; init; }
    public bool BackupOnly { get; init; }
}

/// <summary>Response of <c>GET /api/v1/search</c>.</summary>
public sealed record SearchResponse
{
    public IReadOnlyList<WorkDto> Results { get; init; } = [];
}

public sealed record WorkDto
{
    public string WorkId { get; init; } = string.Empty;
    public string MediaType { get; init; } = "movie";
    public string Title { get; init; } = string.Empty;
    public int? Year { get; init; }
    public int? TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? OriginalTitle { get; init; }
    public string? Tagline { get; init; }
    public string? OfficialRating { get; init; }
    public float? CommunityRating { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    public IReadOnlyList<string> Studios { get; init; } = [];
    public IReadOnlyList<string> ProductionLocations { get; init; } = [];
    public IReadOnlyList<PersonDto> People { get; init; } = [];
    public string? TrailerUrl { get; init; }
    public bool AddStreamarrBadge { get; init; } = true;
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public IReadOnlyList<ReleaseDto> Releases { get; init; } = [];
}

public sealed record TvSeriesSearchResponse
{
    public IReadOnlyList<TvSeriesDto> Results { get; init; } = [];
}

public sealed record TvSeriesDto
{
    public string WorkId { get; init; } = string.Empty;
    public string MediaType { get; init; } = "series";
    public string Title { get; init; } = string.Empty;
    public int? Year { get; init; }
    public int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public int? RuntimeMinutes { get; init; }
    public int? SeasonCount { get; init; }
    public int? EpisodeCount { get; init; }
    public string? OriginalTitle { get; init; }
    public string? Tagline { get; init; }
    public string? OfficialRating { get; init; }
    public float? CommunityRating { get; init; }
    public IReadOnlyList<string> Genres { get; init; } = [];
    public IReadOnlyList<string> Studios { get; init; } = [];
    public IReadOnlyList<string> ProductionLocations { get; init; } = [];
    public IReadOnlyList<PersonDto> People { get; init; } = [];
    public string? TrailerUrl { get; init; }
    public bool AddStreamarrBadge { get; init; } = true;
}

public sealed record TvSeriesDetailsResponse
{
    public TvSeriesDto Series { get; init; } = new();
    public IReadOnlyList<TvSeasonDto> Seasons { get; init; } = [];
}

public sealed record TvSeasonDto
{
    public string WorkId { get; init; } = string.Empty;
    public string MediaType { get; init; } = "season";
    public int TmdbId { get; init; }
    public int SeasonNumber { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public string? PosterUrl { get; init; }
    public int EpisodeCount { get; init; }
}

public sealed record TvSeasonDetailsResponse
{
    public TvSeriesDto Series { get; init; } = new();
    public TvSeasonDto Season { get; init; } = new();
    public IReadOnlyList<TvEpisodeDto> Episodes { get; init; } = [];
}

public sealed record TvEpisodeDto
{
    public string WorkId { get; init; } = string.Empty;
    public string MediaType { get; init; } = "episode";
    public int TmdbId { get; init; }
    public string SeriesTitle { get; init; } = string.Empty;
    public int SeasonNumber { get; init; }
    public int EpisodeNumber { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? Overview { get; init; }
    public string? AirDate { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? StillUrl { get; init; }
    public float? CommunityRating { get; init; }
    public IReadOnlyList<PersonDto> People { get; init; } = [];
    public bool AddStreamarrBadge { get; init; } = true;
    public IReadOnlyList<ReleaseDto> Releases { get; init; } = [];

    public WorkDto ToWork() => new()
    {
        WorkId = WorkId,
        MediaType = "episode",
        Title = SeriesTitle,
        TmdbId = TmdbId,
        Overview = Overview,
        PosterUrl = StillUrl,
        RuntimeMinutes = RuntimeMinutes,
        CommunityRating = CommunityRating,
        People = People,
        AddStreamarrBadge = AddStreamarrBadge,
        Season = SeasonNumber,
        Episode = EpisodeNumber,
        Releases = Releases,
    };
}

public sealed record PersonDto
{
    public string Name { get; init; } = string.Empty;
    public string Type { get; init; } = string.Empty;
    public string? Role { get; init; }
    public int? SortOrder { get; init; }
    public int? TmdbId { get; init; }
    public string? ProfileUrl { get; init; }
}

public sealed record ReleaseDto
{
    public string ReleaseId { get; init; } = string.Empty;
    public string Title { get; init; } = string.Empty;
    public string Indexer { get; init; } = string.Empty;
    public long SizeBytes { get; init; }
    public QualityDto Quality { get; init; } = new();
    public IReadOnlyList<string> Languages { get; init; } = [];
    public string? ReleaseGroup { get; init; }
    public int AgeDays { get; init; }
    public int Grabs { get; init; }
    public int Score { get; init; }
    public bool AddScoreToName { get; init; }
    public bool Rejected { get; init; }
    public IReadOnlyList<string> RejectionReasons { get; init; } = [];
    public string Health { get; init; } = "unknown";
}

public sealed record QualityDto
{
    public string? Resolution { get; init; }
    public string? Source { get; init; }
    public string? Codec { get; init; }
    public string? Hdr { get; init; }
    public string? Audio { get; init; }
    public string? Edition { get; init; }
    public bool Proper { get; init; }
    public bool Repack { get; init; }
}

/// <summary>Body of <c>POST /api/v1/resolve</c>.</summary>
public sealed record ResolveRequest
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
}

/// <summary>Response of <c>POST /api/v1/resolve</c>.</summary>
public sealed record ResolveResponse
{
    public string ReleaseId { get; init; } = string.Empty;

    /// <summary>"ready" | "degraded" | "dead".</summary>
    public string Status { get; init; } = "dead";

    public string? StreamUrl { get; init; }
    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long? RunTimeTicks { get; init; }
    public IReadOnlyList<MediaStreamInfo> MediaStreams { get; init; } = [];
    public int SessionTtlSeconds { get; init; }
    public string? SuggestedFallbackReleaseId { get; init; }
    public string? FallbackFromReleaseId { get; init; }
    public IReadOnlyList<ResolveAttempt> Attempts { get; init; } = [];
}

public sealed record ResolveAttempt
{
    public string ReleaseId { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
}

public sealed record MediaStreamInfo
{
    /// <summary>"Video" | "Audio" | "Subtitle".</summary>
    public string Type { get; init; } = "Video";

    public string? Codec { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public int? Channels { get; init; }
    public string? Language { get; init; }
}

/// <summary>Body of <c>POST /api/v1/events</c>.</summary>
public sealed record EventRequest
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }

    /// <summary>"start" | "progress" | "stop".</summary>
    public required string Event { get; init; }

    public long? PositionTicks { get; init; }
    public string? Source { get; init; }
    public string? PlaybackSessionId { get; init; }
    public string? ExternalUserId { get; init; }
    public string? ExternalUserName { get; init; }
    public string? DeviceName { get; init; }
}

/// <summary>Typed error envelope returned by every Core Server endpoint.</summary>
public sealed record ErrorResponse
{
    [JsonPropertyName("error")]
    public ErrorDetail? Error { get; init; }
}

public sealed record ErrorDetail
{
    public string? Code { get; init; }
    public string? Message { get; init; }
}
