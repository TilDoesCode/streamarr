using System.Reflection;
using Microsoft.AspNetCore.Mvc;

namespace Streamarr.Server.Controllers;

public sealed record HealthResponse
{
    public required string Status { get; init; }
    public required string Version { get; init; }
}

/// <summary>
/// Liveness endpoint (BRIEF.md §6.2). Per-indexer and per-provider reachability
/// details are added in later milestones.
/// </summary>
[ApiController]
[Route("api/v1/health")]
public class HealthController : ControllerBase
{
    [HttpGet]
    public ActionResult<HealthResponse> Get()
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";

        return Ok(new HealthResponse
        {
            Status = "ok",
            Version = version,
        });
    }
}
