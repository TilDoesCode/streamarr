namespace Streamarr.Server.Contracts;

/// <summary>
/// Operator-facing storage overview for the Files screen (GET /api/v1/storage): what Streamarr
/// currently keeps in memory and on disk, against which budgets, and how much disk is left.
/// </summary>
public sealed record StorageResponse
{
    public required StorageDisk Disk { get; init; }
    public required StorageSegmentCache SegmentCache { get; init; }
    public required StoragePreDownload PreDownload { get; init; }
    public required StorageNzbLibrary NzbLibrary { get; init; }
    public required StorageEphemeral Ephemeral { get; init; }
}

/// <summary>Volume hosting the pre-download workspace (the only disk-heavy cache Streamarr writes).</summary>
public sealed record StorageDisk
{
    public long? TotalBytes { get; init; }
    public long? FreeBytes { get; init; }

    /// <summary>Pre-downloads pause below this free-space floor (PreDownload.MinimumFreeDiskBytes).</summary>
    public long MinimumFreeBytes { get; init; }
}

/// <summary>In-memory decoded-article LRU shared by all sessions.</summary>
public sealed record StorageSegmentCache
{
    public int Entries { get; init; }
    public long UsedBytes { get; init; }
    public long CapacityBytes { get; init; }
}

/// <summary>Materialized pre-download files currently on disk.</summary>
public sealed record StoragePreDownload
{
    public required string Path { get; init; }
    public int FileCount { get; init; }
    public long UsedBytes { get; init; }
}

/// <summary>Persistent NZB cache (SQLite metadata + .nzb files on disk).</summary>
public sealed record StorageNzbLibrary
{
    public int Entries { get; init; }
    public int MaxEntries { get; init; }
    public long UsedBytes { get; init; }
    public long BudgetBytes { get; init; }
}

/// <summary>Logical ephemeral-cache occupancy (capability files counted against the LRU byte budget).</summary>
public sealed record StorageEphemeral
{
    public int Files { get; init; }
    public long UsedBytes { get; init; }
    public long BudgetBytes { get; init; }
}
