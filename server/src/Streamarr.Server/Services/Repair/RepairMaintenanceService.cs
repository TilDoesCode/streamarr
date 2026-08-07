using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Startup and periodic hygiene for the repair subsystem: validates published artifacts
/// after a restart, discards stale partial work, and applies TTL/budget eviction.
/// </summary>
public sealed class RepairMaintenanceService(
    RepairWorkspace workspace,
    RepairArtifactCache artifactCache,
    IOptions<StreamarrOptions> options,
    ILogger<RepairMaintenanceService> logger,
    StreamarrMetrics? metrics = null) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Repair.Enabled)
            return;

        try
        {
            artifactCache.ArtifactEvicted += _ => metrics?.RepairArtifactEvicted();
            workspace.CleanStaleStaging();
            artifactCache.LoadExisting();
        }
        catch (Exception e)
        {
            logger.LogError(
                "Repair workspace startup maintenance failed ({FailureType})",
                e.GetType().Name);
        }

        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                try
                {
                    var evicted = artifactCache.Sweep();
                    if (evicted > 0)
                        logger.LogInformation("Repair artifact sweep evicted {Count} artifact(s)", evicted);
                }
                catch (Exception e)
                {
                    logger.LogWarning(
                        "Repair artifact sweep failed ({FailureType})",
                        e.GetType().Name);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
