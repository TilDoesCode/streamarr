using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Contracts;

public sealed record NotificationConfigResponse
{
    public bool Enabled { get; init; }
    public string? AppToken { get; init; }
    public bool HasAppToken { get; init; }
    public string? UserKey { get; init; }
    public bool HasUserKey { get; init; }
    public string Device { get; init; } = string.Empty;
    public string Sound { get; init; } = string.Empty;
    public bool NotifyApplicationStarted { get; init; }
    public bool NotifyPlaybackStarted { get; init; }
    public bool NotifyPlaybackProgress { get; init; }
    public bool NotifyPlaybackStopped { get; init; }
    public bool NotifyResolveSucceeded { get; init; }
    public bool NotifyResolveFailed { get; init; }
    public bool NotifyErrors { get; init; }
    public bool NotifyOutages { get; init; }
    public bool NotifyRecoveries { get; init; }
    public bool IncludeUserName { get; init; }
    public bool IncludeDeviceName { get; init; }
    public bool IncludeReleaseId { get; init; }
    public int UsagePriority { get; init; }
    public int ErrorPriority { get; init; }
    public int OutagePriority { get; init; }
    public int RecoveryPriority { get; init; }
    public int ProgressIntervalMinutes { get; init; }
    public int ErrorCooldownSeconds { get; init; }
    public int MonitorIntervalSeconds { get; init; }
    public int OutageFailureThreshold { get; init; }
    public int OutageReminderMinutes { get; init; }
    public int EmergencyRetrySeconds { get; init; }
    public int EmergencyExpireSeconds { get; init; }

    public static NotificationConfigResponse From(NotificationConfigEntity e) => new()
    {
        Enabled = e.Enabled,
        AppToken = SecretMasking.Masked(e.AppTokenEncrypted),
        HasAppToken = !string.IsNullOrEmpty(e.AppTokenEncrypted),
        UserKey = SecretMasking.Masked(e.UserKeyEncrypted),
        HasUserKey = !string.IsNullOrEmpty(e.UserKeyEncrypted),
        Device = e.Device,
        Sound = e.Sound,
        NotifyApplicationStarted = e.NotifyApplicationStarted,
        NotifyPlaybackStarted = e.NotifyPlaybackStarted,
        NotifyPlaybackProgress = e.NotifyPlaybackProgress,
        NotifyPlaybackStopped = e.NotifyPlaybackStopped,
        NotifyResolveSucceeded = e.NotifyResolveSucceeded,
        NotifyResolveFailed = e.NotifyResolveFailed,
        NotifyErrors = e.NotifyErrors,
        NotifyOutages = e.NotifyOutages,
        NotifyRecoveries = e.NotifyRecoveries,
        IncludeUserName = e.IncludeUserName,
        IncludeDeviceName = e.IncludeDeviceName,
        IncludeReleaseId = e.IncludeReleaseId,
        UsagePriority = e.UsagePriority,
        ErrorPriority = e.ErrorPriority,
        OutagePriority = e.OutagePriority,
        RecoveryPriority = e.RecoveryPriority,
        ProgressIntervalMinutes = e.ProgressIntervalMinutes,
        ErrorCooldownSeconds = e.ErrorCooldownSeconds,
        MonitorIntervalSeconds = e.MonitorIntervalSeconds,
        OutageFailureThreshold = e.OutageFailureThreshold,
        OutageReminderMinutes = e.OutageReminderMinutes,
        EmergencyRetrySeconds = e.EmergencyRetrySeconds,
        EmergencyExpireSeconds = e.EmergencyExpireSeconds,
    };
}

public sealed record NotificationTestResponse
{
    public required bool Success { get; init; }
    public required string Message { get; init; }
}
