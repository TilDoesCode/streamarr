using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Indexers;
using Streamarr.Server.Config;

namespace Streamarr.Server.Controllers;

public sealed record ReachabilityStatus
{
    public required string Name { get; init; }
    public required bool Reachable { get; init; }
    public double? LatencyMs { get; init; }
    public string? Error { get; init; }
}

public sealed record HealthResponse
{
    public required string Status { get; init; }
    public required string Version { get; init; }
    public IReadOnlyList<ReachabilityStatus> Indexers { get; init; } = [];
    public IReadOnlyList<ReachabilityStatus> Providers { get; init; } = [];
}

/// <summary>
/// GET /api/v1/health (BRIEF §6.2): liveness plus per-indexer (t=caps) and per-provider
/// (connect + AUTHINFO) reachability. Reachability checks are time-boxed and isolated so
/// one dead dependency never fails the probe. Unauthenticated liveness; pass
/// <c>?deep=false</c> to skip the reachability probes.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/v1/health")]
public class HealthController(
    IIndexerConfigStore indexers,
    IndexerCapsTester indexerTester,
    ProviderConfigService providers,
    ProviderConnectionTester providerTester) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(HealthResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<HealthResponse>> Get([FromQuery] bool deep = true, CancellationToken ct = default)
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

        if (!deep)
            return Ok(new HealthResponse { Status = "ok", Version = version });

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(20));
        var probeCt = timeoutCts.Token;

        var indexerChecks = indexers.GetEnabled()
            .Select(async i =>
            {
                var result = await indexerTester.TestAsync(i, probeCt);
                return new ReachabilityStatus
                {
                    Name = i.Name,
                    Reachable = result.Success,
                    LatencyMs = result.LatencyMs,
                    Error = result.Error,
                };
            });

        var providerEntities = await providers.ListAsync(ct);
        var providerChecks = providerEntities
            .Where(p => p.Enabled)
            .Select(async p =>
            {
                var (ok, error) = await providerTester.ProbeAsync(providers.ToProvider(p), probeCt);
                return new ReachabilityStatus { Name = p.Name, Reachable = ok, Error = error };
            });

        var indexerResults = await Task.WhenAll(indexerChecks);
        var providerResults = await Task.WhenAll(providerChecks);

        var allReachable = indexerResults.All(r => r.Reachable) && providerResults.All(r => r.Reachable);

        return Ok(new HealthResponse
        {
            Status = allReachable ? "ok" : "degraded",
            Version = version,
            Indexers = indexerResults,
            Providers = providerResults,
        });
    }
}
