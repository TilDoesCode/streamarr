namespace Streamarr.Server.Persistence.Entities;

/// <summary>Singleton Pushover delivery and event-routing configuration.</summary>
public sealed class NotificationConfigEntity
{
    public int Id { get; set; } = 1;
    public bool Enabled { get; set; }
    public string? AppTokenEncrypted { get; set; }
    public string? UserKeyEncrypted { get; set; }
    public string Device { get; set; } = string.Empty;
    public string Sound { get; set; } = string.Empty;

    public bool NotifyApplicationStarted { get; set; }
    public bool NotifyPlaybackStarted { get; set; } = true;
    public bool NotifyPlaybackProgress { get; set; }
    public bool NotifyPlaybackStopped { get; set; } = true;
    public bool NotifyResolveSucceeded { get; set; }
    public bool NotifyResolveFailed { get; set; } = true;
    public bool NotifyErrors { get; set; } = true;
    public bool NotifyOutages { get; set; } = true;
    public bool NotifyRecoveries { get; set; } = true;

    public bool IncludeUserName { get; set; } = true;
    public bool IncludeDeviceName { get; set; } = true;
    public bool IncludeReleaseId { get; set; }

    public int UsagePriority { get; set; }
    public int ErrorPriority { get; set; } = 1;
    public int OutagePriority { get; set; } = 1;
    public int RecoveryPriority { get; set; }
    public int ProgressIntervalMinutes { get; set; } = 30;
    public int ErrorCooldownSeconds { get; set; } = 300;
    public int MonitorIntervalSeconds { get; set; } = 60;
    public int OutageFailureThreshold { get; set; } = 3;
    public int OutageReminderMinutes { get; set; }
    public int EmergencyRetrySeconds { get; set; } = 60;
    public int EmergencyExpireSeconds { get; set; } = 3600;
}
