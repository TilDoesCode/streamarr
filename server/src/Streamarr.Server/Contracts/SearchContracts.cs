namespace Streamarr.Server.Contracts;

/// <summary>Response of GET /api/v1/search — the exact shape from BRIEF §6.2.</summary>
public sealed record SearchResponse
{
    public required IReadOnlyList<WorkDto> Results { get; init; }
}

/// <summary>One aggregated work with its ranked releases (BRIEF §6.2 / §7.4).</summary>
public sealed record WorkDto
{
    public required string WorkId { get; init; }

    /// <summary>"movie" or "tv".</summary>
    public required string MediaType { get; init; }

    public required string Title { get; init; }
    public int? Year { get; init; }
    public int? TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public int? RuntimeMinutes { get; init; }

    /// <summary>Set for TV works.</summary>
    public int? Season { get; init; }
    public int? Episode { get; init; }

    public required IReadOnlyList<ReleaseDto> Releases { get; init; }
}

/// <summary>
/// A ranked release as surfaced by <c>/search</c>. The NZB URL and indexer API key are
/// never present here — they stay server-side (BRIEF §6.2).
/// </summary>
public sealed record ReleaseDto
{
    public required string ReleaseId { get; init; }
    public required string Title { get; init; }
    public required string Indexer { get; init; }
    public long SizeBytes { get; init; }
    public required QualityDto Quality { get; init; }
    public IReadOnlyList<string> Languages { get; init; } = [];
    public string? ReleaseGroup { get; init; }
    public int AgeDays { get; init; }
    public int Grabs { get; init; }
    public int Score { get; init; }
    public bool Rejected { get; init; }
    public IReadOnlyList<string> RejectionReasons { get; init; } = [];

    /// <summary>"unknown" | "ready" | "degraded" | "dead" (known only after a resolve).</summary>
    public required string Health { get; init; }
}

/// <summary>Parsed quality attributes of a release (BRIEF §6.2 / §7.1).</summary>
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

// ---- /debug/search -------------------------------------------------------------------

/// <summary>Request body of POST /api/v1/debug/search (BRIEF §6.2). Mirrors the /search params.</summary>
public sealed record DebugSearchRequest
{
    public required string Q { get; init; }
    public string? Type { get; init; }
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public string? ImdbId { get; init; }
    public int? TmdbId { get; init; }
    public string? ProfileId { get; init; }
}

/// <summary>
/// Response of POST /api/v1/debug/search: every release including rejected ones, with
/// parsed fields, per-rule score breakdown and rejection reasons (BRIEF §6.2). Powers
/// the ranker-tuning view; still never exposes NZB URLs.
/// </summary>
public sealed record DebugSearchResponse
{
    public required IReadOnlyList<DebugWorkDto> Results { get; init; }
    public required IReadOnlyList<IndexerDiagnosticDto> Indexers { get; init; }
}

public sealed record DebugWorkDto
{
    public required string WorkId { get; init; }
    public required string MediaType { get; init; }
    public required string Title { get; init; }
    public int? Year { get; init; }
    public int? TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public int? RuntimeMinutes { get; init; }
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public required IReadOnlyList<DebugReleaseDto> Releases { get; init; }
}

public sealed record DebugReleaseDto
{
    public required string ReleaseId { get; init; }
    public required string Title { get; init; }
    public required string Indexer { get; init; }
    public long SizeBytes { get; init; }
    public int AgeDays { get; init; }
    public int Grabs { get; init; }
    public int Score { get; init; }
    public bool Rejected { get; init; }
    public required string Health { get; init; }
    public required ParsedFieldsDto Parsed { get; init; }
    public required IReadOnlyList<ScoreLineDto> ScoreBreakdown { get; init; }
    public required IReadOnlyList<RejectionDto> Rejections { get; init; }
}

/// <summary>The raw parser output for a release (BRIEF §7.1), surfaced for tuning.</summary>
public sealed record ParsedFieldsDto
{
    public string? Title { get; init; }
    public int? Year { get; init; }
    public required string MediaType { get; init; }
    public string? Resolution { get; init; }
    public string? Source { get; init; }
    public string? VideoCodec { get; init; }
    public string? Hdr { get; init; }
    public string? AudioCodec { get; init; }
    public string? AudioChannels { get; init; }
    public bool Atmos { get; init; }
    public string? Edition { get; init; }
    public string? ReleaseGroup { get; init; }
    public bool Proper { get; init; }
    public bool Repack { get; init; }
    public IReadOnlyList<string> Languages { get; init; } = [];
    public int? Season { get; init; }
    public IReadOnlyList<int> Episodes { get; init; } = [];
    public IReadOnlyList<int> AbsoluteEpisodes { get; init; } = [];
    public bool SeasonPack { get; init; }
    public string? AirDate { get; init; }
}

/// <summary>One line of the score breakdown (BRIEF §7.3): a rule and its point value.</summary>
public sealed record ScoreLineDto
{
    public required string Rule { get; init; }
    public required int Points { get; init; }
}

/// <summary>A machine-readable rejection reason (BRIEF §7.2).</summary>
public sealed record RejectionDto
{
    public required string Code { get; init; }
    public required string Message { get; init; }
}

/// <summary>Per-indexer fan-out diagnostics for the debug view.</summary>
public sealed record IndexerDiagnosticDto
{
    public required string IndexerId { get; init; }
    public required string IndexerName { get; init; }
    public required string Status { get; init; }
    public int ItemCount { get; init; }
    public double ElapsedMs { get; init; }
    public string? Error { get; init; }
}
