namespace Streamarr.Server.Contracts;

/// <summary>Admin view of one repair job (GET /api/v1/repairs, /api/v1/repairs/{jobId}).</summary>
public sealed record RepairJobResponse
{
    public required string JobId { get; init; }
    public required string Fingerprint { get; init; }
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }
    public string? ReleaseTitle { get; init; }
    public required string Disposition { get; init; }
    public required string State { get; init; }
    public string? Phase { get; init; }
    public required DateTimeOffset CreatedAtUtc { get; init; }
    public DateTimeOffset? CompletedAtUtc { get; init; }
    public long ProcessedBytes { get; init; }
    public long TotalBytes { get; init; }
    public int ProgressPercent { get; init; }
    public long SourceBytesDownloaded { get; init; }
    public long ParityBytesDownloaded { get; init; }
    public int DamagedBlocks { get; init; }
    public int RecoveryBlocksUsed { get; init; }
    public int Waiters { get; init; }
    public double? EtaSeconds { get; init; }
    public string? FailureReason { get; init; }

    /// <summary>Redacted state-transition log for live debugging (bounded).</summary>
    public IReadOnlyList<RepairJobEventResponse> Events { get; init; } = [];
}

public sealed record RepairJobEventResponse(DateTimeOffset AtUtc, string State, string Message);

/// <summary>One published repair artifact in the cache.</summary>
public sealed record RepairArtifactResponse
{
    public required string Fingerprint { get; init; }
    public required string ReleaseTitle { get; init; }
    public required long Bytes { get; init; }
    public required DateTimeOffset CreatedUtc { get; init; }
    public required DateTimeOffset LastAccessUtc { get; init; }
    public required int PinCount { get; init; }
}

/// <summary>GET /api/v1/repairs — jobs, artifacts and cache budget at a glance.</summary>
public sealed record RepairOverviewResponse
{
    public required bool Enabled { get; init; }
    public required string Policy { get; init; }
    public required IReadOnlyList<RepairJobResponse> Jobs { get; init; }
    public required IReadOnlyList<RepairArtifactResponse> Artifacts { get; init; }
    public required long CacheBytesUsed { get; init; }
    public required long CacheBudgetBytes { get; init; }
}

/// <summary>POST /api/v1/repairs — idempotent manual start for a registered release.</summary>
public sealed record StartRepairRequest
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }
}

/// <summary>Capability-token-bound repair status for an active session (no ids beyond the job).</summary>
public sealed record SessionRepairStatusResponse
{
    public required string Playability { get; init; }
    public RepairStatusInfo? Repair { get; init; }
}

/// <summary>
/// Two-phase playback admission (POST/GET /api/v1/playback-sessions): the POST answers
/// within a hard budget; "preparing" answers carry a pollable admission id while health
/// check, materialization, ffprobe and repair analysis continue server-side.
/// </summary>
public sealed record PlaybackAdmissionResponse
{
    public required string AdmissionId { get; init; }

    /// <summary>"preparing" | "ready" | "failed".</summary>
    public required string Phase { get; init; }

    public int? RetryAfterSeconds { get; init; }

    /// <summary>The full resolve result once phase is "ready" (or terminal "failed" detail).</summary>
    public ResolveResponse? Resolve { get; init; }

    /// <summary>Redacted failure classification when phase is "failed".</summary>
    public string? Error { get; init; }
}
