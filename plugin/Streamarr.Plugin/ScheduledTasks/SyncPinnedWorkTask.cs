using MediaBrowser.Model.Tasks;
using Streamarr.Plugin.Bootstrap;

namespace Streamarr.Plugin.ScheduledTasks;

/// <summary>
/// "Sync one pinned work" — the manual bootstrap task backing the M5 thin-slice
/// (BRIEF §8.3). Runs the configured pinned query and materializes one ephemeral item.
/// No default triggers: it is run on demand from Scheduled Tasks or the plugin config page.
/// </summary>
public sealed class SyncPinnedWorkTask(PinnedWorkBootstrapper bootstrapper) : IScheduledTask
{
    public string Name => "Streamarr: sync pinned work";

    public string Key => "StreamarrSyncPinnedWork";

    public string Description => "Materialize one ephemeral Streamarr item from the configured pinned query (M5 thin-slice).";

    public string Category => "Streamarr";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);
        var query = Plugin.Instance?.Configuration.PinnedWorkQuery ?? string.Empty;
        await bootstrapper.RunAsync(query, cancellationToken).ConfigureAwait(false);
        progress.Report(100);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => [];
}
