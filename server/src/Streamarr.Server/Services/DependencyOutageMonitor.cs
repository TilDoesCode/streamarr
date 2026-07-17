using Streamarr.Server.Config;
using Streamarr.Server.Controllers;

namespace Streamarr.Server.Services;

public sealed class DependencyOutageMonitor(
    DeepHealthDiagnostics diagnostics,
    NotificationConfigService configService,
    PushoverNotificationService notifications,
    TimeProvider time,
    ILogger<DependencyOutageMonitor> logger) : BackgroundService
{
    private readonly Dictionary<string, DependencyState> _states = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var config = await configService.GetAsync(stoppingToken);
                if (config.Enabled && (config.NotifyOutages || config.NotifyRecoveries))
                {
                    var health = await diagnostics.GetAsync(stoppingToken);
                    foreach (var dependency in health.Indexers.Select(x => ("Indexer", x))
                                 .Concat(health.Providers.Select(x => ("Provider", x))))
                    {
                        Observe(
                            $"{dependency.Item1}:{dependency.x.Name}",
                            dependency.Item1,
                            dependency.x,
                            config.OutageFailureThreshold,
                            config.OutageReminderMinutes);
                    }
                }

                await Task.Delay(TimeSpan.FromSeconds(Math.Max(15, config.MonitorIntervalSeconds)), time, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Dependency outage monitor probe failed");
                await Task.Delay(TimeSpan.FromSeconds(30), time, stoppingToken);
            }
        }
    }

    private void Observe(
        string key,
        string type,
        ReachabilityStatus result,
        int failureThreshold,
        int reminderMinutes)
    {
        if (!_states.TryGetValue(key, out var state))
            state = new DependencyState();

        if (result.Reachable)
        {
            if (state.IsDown)
            {
                notifications.Enqueue(new NotificationEvent(
                    NotificationEventKind.Recovery,
                    $"{type} recovered",
                    $"{result.Name} is reachable again after {FormatDuration(time.GetUtcNow() - state.DownSince)}.",
                    key));
            }
            _states[key] = new DependencyState();
            return;
        }

        state.Failures++;
        var now = time.GetUtcNow();
        if (!state.IsDown && state.Failures >= Math.Max(1, failureThreshold))
        {
            state.IsDown = true;
            state.DownSince = now;
            state.LastAlert = now;
            notifications.Enqueue(new NotificationEvent(
                NotificationEventKind.Outage,
                $"{type} outage",
                $"{result.Name} is unreachable ({result.Error ?? "health check failed"}).",
                key));
        }
        else if (state.IsDown && reminderMinutes > 0 &&
                 now - state.LastAlert >= TimeSpan.FromMinutes(reminderMinutes))
        {
            state.LastAlert = now;
            notifications.Enqueue(new NotificationEvent(
                NotificationEventKind.Outage,
                $"{type} still unavailable",
                $"{result.Name} has been unreachable for {FormatDuration(now - state.DownSince)}.",
                key));
        }
        _states[key] = state;
    }

    private static string FormatDuration(TimeSpan duration)
        => duration.TotalHours >= 1
            ? $"{duration.TotalHours:0.#} hours"
            : $"{Math.Max(1, duration.TotalMinutes):0} minutes";

    private sealed class DependencyState
    {
        public int Failures { get; set; }
        public bool IsDown { get; set; }
        public DateTimeOffset DownSince { get; set; }
        public DateTimeOffset LastAlert { get; set; }
    }
}
