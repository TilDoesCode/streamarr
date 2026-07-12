namespace Streamarr.Core.Media;

public enum ReleaseHealth
{
    Unknown,
    Ready,
    Degraded,
    Dead,
}

/// <summary>Parsed quality attributes of a release name (BRIEF.md §7.1).</summary>
public sealed record QualityInfo
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

/// <summary>
/// One concrete Usenet release of a work, as surfaced by an indexer.
/// The NZB URL stays server-side and is never exposed through the API.
/// </summary>
public sealed record Release
{
    /// <summary>Stable id derived from the indexer guid (sha256), used by /resolve.</summary>
    public required string ReleaseId { get; init; }

    /// <summary>Raw release name.</summary>
    public required string Title { get; init; }

    public required string Indexer { get; init; }
    public required long SizeBytes { get; init; }

    public QualityInfo Quality { get; init; } = new();
    public IReadOnlyList<string> Languages { get; init; } = [];
    public string? ReleaseGroup { get; init; }

    public int AgeDays { get; init; }
    public int Grabs { get; init; }

    /// <summary>Integer score from the ranking profile; sorted descending per work.</summary>
    public int Score { get; init; }

    public bool Rejected { get; init; }
    public IReadOnlyList<string> RejectionReasons { get; init; } = [];

    public ReleaseHealth Health { get; init; } = ReleaseHealth.Unknown;

    /// <summary>Server-side only: where to fetch the NZB. Never serialized to clients.</summary>
    public string? NzbUrl { get; init; }
}
