namespace Streamarr.Server.Contracts;

/// <summary>A ranking profile by id and name, and where the choice came from (<c>viewer</c> or <c>server</c>).</summary>
public sealed record RankingProfileRefDto
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary><c>viewer</c> (the viewer's own choice) or <c>server</c> (the server default).</summary>
    public required string Source { get; init; }
}

/// <summary>What a profile prefers, derived from its rules so an app can describe it in the viewer's language.</summary>
public sealed record RankingProfileTraitsDto
{
    /// <summary>The resolution it prefers most (e.g. <c>2160p</c>, <c>1080p</c>); null when it has no resolution preference.</summary>
    public string? PreferredResolution { get; init; }

    /// <summary>The highest resolution it ranks at all; null when it lists none.</summary>
    public string? MaxResolution { get; init; }

    /// <summary><c>prefer</c> or <c>avoid</c> when its formats score HDR / Dolby Vision; null when HDR plays no role.</summary>
    public string? Hdr { get; init; }

    /// <summary>The video codec it prefers most: <c>hevc</c>, <c>av1</c> or <c>h264</c>; null when none.</summary>
    public string? Codec { get; init; }

    /// <summary>Its audio languages, best first (at most three ISO 639-1 codes).</summary>
    public IReadOnlyList<string> Languages { get; init; } = [];

    /// <summary>It never ranks 4K: fewer bytes per minute, steadier on slow connections.</summary>
    public bool SavesBandwidth { get; init; }
}

/// <summary>A profile a viewer may pick: no rules, group lists, custom formats or import details.</summary>
public sealed record ViewerRankingProfileDto
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>The operator's short description, when they wrote one.</summary>
    public string? Description { get; init; }

    /// <summary>The media types it ranks: <c>movie</c> and/or <c>series</c>.</summary>
    public required IReadOnlyList<string> MediaTypes { get; init; }

    public required RankingProfileTraitsDto Traits { get; init; }

    /// <summary>The server default for at least one media type.</summary>
    public bool ServerDefault { get; init; }
}

/// <summary>The server defaults per media type.</summary>
public sealed record RankingProfileDefaultsDto
{
    public required RankingProfileRefDto Movie { get; init; }
    public required RankingProfileRefDto Series { get; init; }
}

/// <summary>The signed-in viewer's ranking profile: their choice, what ranks movies and series for them, and what they may pick.</summary>
public sealed record ViewerRankingProfileResponse
{
    /// <summary>The viewer's own choice; null follows the server default.</summary>
    public string? ProfileId { get; init; }

    /// <summary>False when the operator does not let viewers choose; the server default applies to everyone then.</summary>
    public required bool CanChoose { get; init; }

    /// <summary>The profile that ranks movies for this viewer now.</summary>
    public required RankingProfileRefDto Movie { get; init; }

    /// <summary>The profile that ranks series for this viewer now.</summary>
    public required RankingProfileRefDto Series { get; init; }

    public required RankingProfileDefaultsDto ServerDefault { get; init; }

    public required IReadOnlyList<ViewerRankingProfileDto> Profiles { get; init; }
}

/// <summary>Sets the viewer's ranking profile; null follows the server default.</summary>
public sealed record ViewerRankingProfileRequest
{
    public string? ProfileId { get; init; }
}

/// <summary>The server-wide ranking defaults (admin).</summary>
public sealed record ProfileDefaultsResponse
{
    /// <summary>The profile for everything without its own choice (<c>default</c> = built-in Standard).</summary>
    public required string DefaultProfileId { get; init; }

    /// <summary>Overrides the default for movies; null = same as the default.</summary>
    public string? MovieProfileId { get; init; }

    /// <summary>Overrides the default for series; null = same as the default.</summary>
    public string? SeriesProfileId { get; init; }

    public required bool ViewersMayChoose { get; init; }

    /// <summary>What ranks movies and series without a viewer choice, after the media-type rules (a series-only default ranks movies with Standard).</summary>
    public required RankingProfileDefaultsDto Effective { get; init; }
}

/// <summary>Replaces the server-wide ranking defaults; null ids fall back (default to Standard, overrides to the default).</summary>
public sealed record ProfileDefaultsRequest
{
    public string? DefaultProfileId { get; init; }
    public string? MovieProfileId { get; init; }
    public string? SeriesProfileId { get; init; }

    /// <summary>Omitted keeps the current value.</summary>
    public bool? ViewersMayChoose { get; init; }
}
