using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>
/// Keeps the viewer service status current without anyone opening the diagnostics page: one shared diagnostics check
/// every <see cref="DiagnosticsOptions.StatusRefreshSeconds"/> (one at a time, the probes' own timeouts apply).
/// </summary>
public sealed class ServiceStatusRefresher(
    DiagnosticsService diagnostics,
    ServiceStatusTracker tracker,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<ServiceStatusRefresher> logger) : BackgroundService
{
    public const int MinIntervalSeconds = 60;
    public const int MaxIntervalSeconds = 900;

    private readonly SemaphoreSlim _gate = new(1, 1);

    /// <summary>Seconds between background checks, or 0 when the refresher is off.</summary>
    public int IntervalSeconds => options.Value.Diagnostics.StatusRefreshSeconds <= 0
        ? 0
        : Math.Clamp(options.Value.Diagnostics.StatusRefreshSeconds, MinIntervalSeconds, MaxIntervalSeconds);

    /// <summary>Runs one check through the shared snapshot (re-probing only once the snapshot cache has expired).</summary>
    public async Task<ServiceStatusResponse> RefreshAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await diagnostics.BuildAsync(refresh: false, redact: false, ct);
            await tracker.AdminNotifiedAsync(ct);
            return tracker.Current!;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The tracked status; checks once when there is none yet or it is older than two refresh periods (or the snapshot lifetime when the refresher is off).</summary>
    public async Task<ServiceStatusResponse> GetAsync(CancellationToken ct)
    {
        var notified = await tracker.AdminNotifiedAsync(ct);
        if (tracker.Current is { } current && !IsStale(current))
            return current with { AdminNotified = notified };
        await _gate.WaitAsync(ct);
        try
        {
            if (tracker.Current is { } afterWait && !IsStale(afterWait))
                return afterWait with { AdminNotified = notified };
            await diagnostics.BuildAsync(refresh: false, redact: false, ct);
            return tracker.Current! with { AdminNotified = notified };
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool IsStale(ServiceStatusResponse status)
    {
        var lifetime = IntervalSeconds > 0
            ? TimeSpan.FromSeconds(IntervalSeconds * 2)
            : TimeSpan.FromSeconds(Math.Max(1, options.Value.DeepHealthCacheSeconds));
        return time.GetUtcNow() - status.CheckedAt > lifetime;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (IntervalSeconds <= 0)
            return;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(0, options.Value.Diagnostics.StatusStartupDelaySeconds)), time, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RefreshAsync(stoppingToken);
                }
                catch (Exception e) when (e is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                {
                    logger.LogWarning(e, "Service status check failed");
                }
                await Task.Delay(TimeSpan.FromSeconds(IntervalSeconds), time, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }
}
