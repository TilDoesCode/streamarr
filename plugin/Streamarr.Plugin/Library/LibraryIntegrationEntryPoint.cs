using MediaBrowser.Controller.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Ensures the "Streamarr" library folder exists and matches the configured placement as soon
/// as the server is up, so the library tile and the Continue Watching / Next Up / Favorites
/// integration work before the first search materializes anything. Runs in the background off
/// the host startup path and is fail-safe: a failure only means the folder is (re)placed on the
/// next materialization or configuration save instead.
/// </summary>
public sealed class LibraryIntegrationEntryPoint(
    EphemeralLibraryService library,
    IServerConfigurationManager configurationManager,
    ILogger<LibraryIntegrationEntryPoint> logger) : IHostedService, IDisposable
{
    private static readonly TimeSpan WizardPollInterval = TimeSpan.FromSeconds(15);

    private readonly CancellationTokenSource _stop = new();
    private Task? _run;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _run = Task.Run(() => EnsureAsync(_stop.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _stop.CancelAsync().ConfigureAwait(false);
        if (_run is { } run)
        {
            try
            {
                await run.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Shutdown wins; the placement is re-ensured on the next start.
            }
        }
    }

    private async Task EnsureAsync(CancellationToken ct)
    {
        try
        {
            // Before the startup wizard completes there is no user root folder row yet, so
            // creating the library folder would violate the parent foreign key. Wait for the
            // wizard instead of racing it; on a configured server this passes immediately.
            while (!configurationManager.Configuration.IsStartupWizardCompleted)
                await Task.Delay(WizardPollInterval, ct).ConfigureAwait(false);

            await library.EnsureLibraryIntegrationAsync(ct).ConfigureAwait(false);
            logger.LogInformation("Streamarr library integration ensured");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                "Could not ensure the Streamarr library at startup ({FailureType}); it will be ensured on first use",
                ex.GetType().Name);
        }
    }

    public void Dispose() => _stop.Dispose();
}
