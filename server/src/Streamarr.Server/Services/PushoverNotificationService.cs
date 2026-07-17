using System.Collections.Concurrent;
using System.Threading.Channels;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Services;

public enum NotificationEventKind
{
    ApplicationStarted,
    PlaybackStarted,
    PlaybackProgress,
    PlaybackStopped,
    ResolveSucceeded,
    ResolveFailed,
    Error,
    Outage,
    Recovery,
}

public sealed record NotificationEvent(
    NotificationEventKind Kind,
    string Title,
    string Message,
    string? ThrottleKey = null,
    string? UserName = null,
    string? DeviceName = null,
    string? ReleaseId = null);

/// <summary>Bounded, asynchronous Pushover delivery so external latency never blocks playback.</summary>
public sealed class PushoverNotificationService(
    NotificationConfigService configService,
    PushoverClient client,
    TimeProvider time,
    ILogger<PushoverNotificationService> logger) : BackgroundService
{
    private readonly Channel<NotificationEvent> _queue = Channel.CreateBounded<NotificationEvent>(
        new BoundedChannelOptions(256)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastSent = new(StringComparer.Ordinal);

    public bool Enqueue(NotificationEvent notification) => _queue.Writer.TryWrite(notification);

    public async Task SendTestAsync(CancellationToken ct)
    {
        var config = await configService.GetAsync(ct);
        var (token, user) = configService.Credentials(config);
        EnsureCredentials(token, user);
        await client.SendAsync(config, token, user, "Streamarr test", "Pushover notifications are configured correctly.", 0, ct);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Enqueue(new NotificationEvent(
            NotificationEventKind.ApplicationStarted,
            "Streamarr started",
            "The Streamarr server is online."));

        await foreach (var notification in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                var config = await configService.GetAsync(stoppingToken);
                if (!config.Enabled || !IsEnabled(config, notification.Kind))
                    continue;

                var (token, user) = configService.Credentials(config);
                if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(user))
                    continue;

                var cooldown = Cooldown(config, notification.Kind);
                var throttleKey = notification.ThrottleKey;
                var now = time.GetUtcNow();
                if (cooldown > TimeSpan.Zero && !string.IsNullOrEmpty(throttleKey) &&
                    _lastSent.TryGetValue($"{notification.Kind}:{throttleKey}", out var last) &&
                    now - last < cooldown)
                {
                    continue;
                }

                var message = BuildMessage(config, notification);
                await client.SendAsync(
                    config,
                    token,
                    user,
                    notification.Title,
                    message,
                    Priority(config, notification.Kind),
                    stoppingToken);
                if (!string.IsNullOrEmpty(throttleKey))
                    _lastSent[$"{notification.Kind}:{throttleKey}"] = now;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                // Do not feed delivery failures back into this notification channel.
                logger.LogWarning(exception, "Pushover notification delivery failed");
            }
        }
    }

    private static bool IsEnabled(NotificationConfigEntity c, NotificationEventKind kind) => kind switch
    {
        NotificationEventKind.ApplicationStarted => c.NotifyApplicationStarted,
        NotificationEventKind.PlaybackStarted => c.NotifyPlaybackStarted,
        NotificationEventKind.PlaybackProgress => c.NotifyPlaybackProgress,
        NotificationEventKind.PlaybackStopped => c.NotifyPlaybackStopped,
        NotificationEventKind.ResolveSucceeded => c.NotifyResolveSucceeded,
        NotificationEventKind.ResolveFailed => c.NotifyResolveFailed,
        NotificationEventKind.Error => c.NotifyErrors,
        NotificationEventKind.Outage => c.NotifyOutages,
        NotificationEventKind.Recovery => c.NotifyRecoveries,
        _ => false,
    };

    private static int Priority(NotificationConfigEntity c, NotificationEventKind kind) => kind switch
    {
        NotificationEventKind.Error or NotificationEventKind.ResolveFailed => c.ErrorPriority,
        NotificationEventKind.Outage => c.OutagePriority,
        NotificationEventKind.Recovery => c.RecoveryPriority,
        _ => c.UsagePriority,
    };

    private static TimeSpan Cooldown(NotificationConfigEntity c, NotificationEventKind kind) => kind switch
    {
        NotificationEventKind.PlaybackProgress => TimeSpan.FromMinutes(c.ProgressIntervalMinutes),
        NotificationEventKind.Error or NotificationEventKind.ResolveFailed => TimeSpan.FromSeconds(c.ErrorCooldownSeconds),
        NotificationEventKind.Outage => TimeSpan.FromMinutes(c.OutageReminderMinutes),
        _ => TimeSpan.Zero,
    };

    private static string BuildMessage(NotificationConfigEntity config, NotificationEvent notification)
    {
        var details = new List<string>();
        if (config.IncludeUserName && !string.IsNullOrWhiteSpace(notification.UserName))
            details.Add($"User: {notification.UserName}");
        if (config.IncludeDeviceName && !string.IsNullOrWhiteSpace(notification.DeviceName))
            details.Add($"Device: {notification.DeviceName}");
        if (config.IncludeReleaseId && !string.IsNullOrWhiteSpace(notification.ReleaseId))
            details.Add($"Release: {notification.ReleaseId}");
        return details.Count == 0
            ? notification.Message
            : $"{notification.Message}\n{string.Join("\n", details)}";
    }

    private static void EnsureCredentials(string token, string user)
    {
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(user))
            throw new InvalidOperationException("A Pushover application token and user/group key are required.");
    }
}
