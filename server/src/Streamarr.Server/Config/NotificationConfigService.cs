using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Config;

public sealed class NotificationConfigService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<NotificationConfigEntity> GetAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await LoadAsync(db, ct);
    }

    public async Task<NotificationConfigEntity> UpdateAsync(NotificationConfigWrite write, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await LoadAsync(db, ct);
            entity.Enabled = write.Enabled;
            entity.Device = Normalize(write.Device, 25);
            entity.Sound = Normalize(write.Sound, 64);
            entity.NotifyApplicationStarted = write.NotifyApplicationStarted;
            entity.NotifyPlaybackStarted = write.NotifyPlaybackStarted;
            entity.NotifyPlaybackProgress = write.NotifyPlaybackProgress;
            entity.NotifyPlaybackStopped = write.NotifyPlaybackStopped;
            entity.NotifyResolveSucceeded = write.NotifyResolveSucceeded;
            entity.NotifyResolveFailed = write.NotifyResolveFailed;
            entity.NotifyErrors = write.NotifyErrors;
            entity.NotifyOutages = write.NotifyOutages;
            entity.NotifyRecoveries = write.NotifyRecoveries;
            entity.IncludeUserName = write.IncludeUserName;
            entity.IncludeDeviceName = write.IncludeDeviceName;
            entity.IncludeReleaseId = write.IncludeReleaseId;
            entity.UsagePriority = write.UsagePriority;
            entity.ErrorPriority = write.ErrorPriority;
            entity.OutagePriority = write.OutagePriority;
            entity.RecoveryPriority = write.RecoveryPriority;
            entity.ProgressIntervalMinutes = write.ProgressIntervalMinutes;
            entity.ErrorCooldownSeconds = write.ErrorCooldownSeconds;
            entity.MonitorIntervalSeconds = write.MonitorIntervalSeconds;
            entity.OutageFailureThreshold = write.OutageFailureThreshold;
            entity.OutageReminderMinutes = write.OutageReminderMinutes;
            entity.EmergencyRetrySeconds = write.EmergencyRetrySeconds;
            entity.EmergencyExpireSeconds = write.EmergencyExpireSeconds;

            if (!SecretMasking.IsOmitted(write.AppToken))
                entity.AppTokenEncrypted = protector.Protect(write.AppToken?.Trim());
            if (!SecretMasking.IsOmitted(write.UserKey))
                entity.UserKeyEncrypted = protector.Protect(write.UserKey?.Trim());

            if (entity.Enabled &&
                (string.IsNullOrEmpty(entity.AppTokenEncrypted) || string.IsNullOrEmpty(entity.UserKeyEncrypted)))
            {
                throw new InvalidOperationException(
                    "An application token and user/group key are required before Pushover can be enabled.");
            }

            await db.SaveChangesAsync(ct);
            return entity;
        }
        finally
        {
            _gate.Release();
        }
    }

    public (string AppToken, string UserKey) Credentials(NotificationConfigEntity entity)
        => (protector.Unprotect(entity.AppTokenEncrypted), protector.Unprotect(entity.UserKeyEncrypted));

    private static string Normalize(string? value, int maxLength)
    {
        value = value?.Trim() ?? string.Empty;
        return value.Length <= maxLength ? value : value[..maxLength];
    }

    private static async Task<NotificationConfigEntity> LoadAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var entity = await db.NotificationConfig.SingleOrDefaultAsync(x => x.Id == 1, ct);
        if (entity is not null)
            return entity;

        entity = new NotificationConfigEntity();
        db.NotificationConfig.Add(entity);
        await db.SaveChangesAsync(ct);
        return entity;
    }
}

public sealed record NotificationConfigWrite
{
    public bool Enabled { get; init; }
    public string? AppToken { get; init; }
    public string? UserKey { get; init; }
    public string? Device { get; init; }
    public string? Sound { get; init; }
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
}
