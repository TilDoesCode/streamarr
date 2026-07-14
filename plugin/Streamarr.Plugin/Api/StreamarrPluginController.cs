using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Common.Api;
using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Bootstrap;

namespace Streamarr.Plugin.Api;

/// <summary>
/// Minimal API surface for the plugin's config page (BRIEF §8.1): a "test connection"
/// button checking anonymous shallow <c>/health</c> plus authenticated <c>/caps</c>, and a
/// button that runs the M5 pinned-work bootstrap. Both are admin-only. No domain logic —
/// the server does the work.
/// </summary>
[ApiController]
[Authorize(Policy = Policies.RequiresElevation)]
[Route("Streamarr")]
[Produces("application/json")]
public sealed class StreamarrPluginController(
    StreamarrApiClient api,
    PinnedWorkBootstrapper bootstrapper,
    ILogger<StreamarrPluginController> logger) : ControllerBase
{
    public sealed record TestConnectionResult(bool Ok, string? Version, string? Status, string? Error);

    public sealed record BootstrapResult(bool Ok, string Message, string? ItemId, string? WorkId);

    /// <summary>
    /// Verifies the configured server URL and API key using shallow health followed by
    /// authenticated capabilities.
    /// </summary>
    [HttpGet("TestConnection")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<TestConnectionResult>> TestConnection(CancellationToken ct)
    {
        try
        {
            var health = await api.TestConnectionAsync(ct).ConfigureAwait(false);
            return Ok(new TestConnectionResult(true, health.Version, health.Status, null));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Streamarr Core connection test failed ({FailureType})", ex.GetType().Name);
            return Ok(new TestConnectionResult(false, null, null, "connection_failed"));
        }
    }

    /// <summary>Runs the pinned-work bootstrap and returns what was materialized.</summary>
    [HttpPost("SyncPinnedWork")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<BootstrapResult>> SyncPinnedWork(CancellationToken ct)
    {
        var query = Plugin.Instance?.Configuration.PinnedWorkQuery ?? string.Empty;
        var result = await bootstrapper.RunAsync(query, ct).ConfigureAwait(false);
        return Ok(new BootstrapResult(result.Success, result.Message, result.ItemId?.ToString(), result.WorkId));
    }
}
