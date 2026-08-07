using Streamarr.Server.Contracts;

namespace Streamarr.Server.Services.Repair;

/// <summary>Maps repair domain state onto the additive API vocabulary (camelCase strings).</summary>
public static class RepairStatusMapper
{
    public static string ToApi(this RepairDisposition disposition) => disposition switch
    {
        RepairDisposition.NotNeeded => "notNeeded",
        RepairDisposition.Repairable => "repairable",
        RepairDisposition.InsufficientParity => "insufficientParity",
        RepairDisposition.Unsupported => "unsupported",
        RepairDisposition.LimitsExceeded => "limitsExceeded",
        _ => "unknown",
    };

    public static string ToApi(this RepairState state) => state switch
    {
        RepairState.Queued => "queued",
        RepairState.Planning => "planning",
        RepairState.MaterializingSources => "materializingSources",
        RepairState.DownloadingRecovery => "downloadingRecovery",
        RepairState.Reconstructing => "reconstructing",
        RepairState.Verifying => "verifying",
        RepairState.Ready => "ready",
        RepairState.Failed => "failed",
        RepairState.Cancelled => "cancelled",
        RepairState.Evicted => "evicted",
        _ => "none",
    };

    public static string ToApi(this RepairPlayability playability) => playability switch
    {
        RepairPlayability.Progressive => "progressive",
        RepairPlayability.Repairing => "repairing",
        RepairPlayability.RepairedReady => "repairedReady",
        RepairPlayability.Unavailable => "unavailable",
        _ => "remoteReady",
    };

    public static string? PhaseOf(RepairState state) => state switch
    {
        RepairState.Planning => "plan",
        RepairState.MaterializingSources => "source",
        RepairState.DownloadingRecovery => "recovery",
        RepairState.Reconstructing => "reconstruct",
        RepairState.Verifying => "verify",
        _ => null,
    };

    public static RepairStatusInfo ToStatusInfo(
        this RepairJobSnapshot snapshot,
        bool progressiveEligible = false,
        int? retryAfterSeconds = null)
        => new()
        {
            JobId = snapshot.JobId,
            Disposition = snapshot.Disposition.ToApi(),
            State = snapshot.State.ToApi(),
            Phase = PhaseOf(snapshot.State),
            ProcessedBytes = snapshot.ProcessedBytes,
            TotalBytes = snapshot.TotalBytes,
            ProgressPercent = snapshot.ProgressPercent,
            EtaSeconds = snapshot.EtaSeconds,
            RetryAfterSeconds = retryAfterSeconds,
            ProgressiveEligible = progressiveEligible,
            FailureReason = snapshot.FailureReason,
        };
}
