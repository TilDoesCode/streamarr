using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Streamarr.Server.Services.Repair;

/// <summary>Planner verdict for one damaged release (state axis 2 of 4).</summary>
public enum RepairDisposition
{
    Unknown,
    NotNeeded,
    Repairable,
    InsufficientParity,
    Unsupported,
    LimitsExceeded,
}

/// <summary>Job state machine (state axis 3 of 4).</summary>
public enum RepairState
{
    None,
    Queued,
    Planning,
    MaterializingSources,
    DownloadingRecovery,
    Reconstructing,
    Verifying,
    Ready,
    Failed,
    Cancelled,
    Evicted,
}

/// <summary>How the release can be played right now (state axis 4 of 4).</summary>
public enum RepairPlayability
{
    RemoteReady,
    Progressive,
    Repairing,
    RepairedReady,
    Unavailable,
}

/// <summary>One redacted, timestamped job event for operator debugging.</summary>
public sealed record RepairJobEvent(DateTimeOffset AtUtc, RepairState State, string Message);

/// <summary>Immutable snapshot of a repair job for APIs and the admin UI.</summary>
public sealed record RepairJobSnapshot
{
    public required string JobId { get; init; }
    public required string Fingerprint { get; init; }
    public required string ReleaseId { get; init; }
    public required string? WorkId { get; init; }
    public required string? ReleaseTitle { get; init; }
    public required RepairDisposition Disposition { get; init; }
    public required RepairState State { get; init; }
    public required DateTimeOffset CreatedAtUtc { get; init; }
    public DateTimeOffset? CompletedAtUtc { get; init; }
    public required long ProcessedBytes { get; init; }
    public required long TotalBytes { get; init; }
    public required long SourceBytesDownloaded { get; init; }
    public required long ParityBytesDownloaded { get; init; }
    public required int DamagedBlocks { get; init; }
    public required int RecoveryBlocksUsed { get; init; }

    /// <summary>Raw byte offset of the first damaged slice within its source file, when known.</summary>
    public long? FirstDamagedByte { get; init; }
    public required int Waiters { get; init; }
    public string? FailureReason { get; init; }
    public double? EtaSeconds { get; init; }
    public required IReadOnlyList<RepairJobEvent> Events { get; init; }

    public int ProgressPercent => TotalBytes <= 0
        ? 0
        : (int)Math.Clamp(ProcessedBytes / (double)TotalBytes * 100, 0, 100);

    public bool IsTerminal => State is RepairState.Ready or RepairState.Failed or RepairState.Cancelled or RepairState.Evicted;
}

/// <summary>Secret-free SHA-256 identity over candidate file layout, segment ids and sizes.</summary>
public static class RepairFingerprint
{
    public static string Compute(MediaFileCandidate candidate)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        sha.AppendData([candidate.IsRarWrapped ? (byte)1 : (byte)0]);
        Span<byte> size = stackalloc byte[sizeof(long)];
        foreach (var file in candidate.Files)
        {
            sha.AppendData([0xF1]);
            AppendString(sha, file.GetSubjectFileName());
            foreach (var segment in file.Segments)
            {
                sha.AppendData([0xF2]);
                AppendString(sha, segment.MessageId);
                BinaryPrimitives.WriteInt64BigEndian(size, segment.Bytes);
                sha.AppendData(size);
            }
        }
        return Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant()[..32];
    }

    private static void AppendString(IncrementalHash sha, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
        sha.AppendData(length);
        sha.AppendData(bytes);
    }
}
