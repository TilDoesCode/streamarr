using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Plugin.Bootstrap;

namespace Streamarr.Plugin.Api;

/// <summary>
/// Minimal API surface for the plugin's config page (BRIEF §8.1): a "test connection"
/// button hitting the Core Server's <c>/health</c>, and a button that runs the M5
/// pinned-work bootstrap. Both are admin-only. No domain logic — the server does the work.
/// </summary>
[ApiController]
[Authorize(Policy = "DefaultAuthorization")]
[Route("Streamarr")]
[Produces("application/json")]
public sealed class StreamarrPluginController(
    StreamarrApiClient api,
    PinnedWorkBootstrapper bootstrapper) : ControllerBase
{
    public sealed record TestConnectionResult(bool Ok, string? Version, string? Status, string? Error);

    public sealed record BootstrapResult(bool Ok, string Message, string? ItemId, string? WorkId);

    /// <summary>Verifies the configured server URL + API key by calling <c>GET /api/v1/health</c>.</summary>
    [HttpGet("TestConnection")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<TestConnectionResult>> TestConnection(CancellationToken ct)
    {
        try
        {
            var health = await api.GetHealthAsync(ct).ConfigureAwait(false);
            return Ok(new TestConnectionResult(true, health?.Version, health?.Status, null));
        }
        catch (Exception ex)
        {
            return Ok(new TestConnectionResult(false, null, null, ex.Message));
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
