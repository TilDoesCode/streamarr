namespace Streamarr.Server.Viewers.Auth;

/// <summary>Hourly removal of ended viewer sessions (kept as tombstones) and of tombstones older than 30 days.</summary>
public sealed class ViewerSessionCleanup(ViewerSessionService sessions, ILogger<ViewerSessionCleanup> logger) : BackgroundService
{
    private static readonly TimeSpan FirstRun = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Interval = TimeSpan.FromHours(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(FirstRun, stoppingToken);
            using var timer = new PeriodicTimer(Interval);
            do
            {
                try
                {
                    var removed = await sessions.PruneAsync(stoppingToken);
                    if (removed > 0)
                        logger.LogInformation("Removed {Count} ended viewer sessions", removed);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Viewer session cleanup failed");
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException)
        {
        }
    }
}
