using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// General config GET/PUT (BRIEF §6.2): TMDB key, TTLs, cache sizes, NNTP budget. The
/// TMDB credential is write-only (masked on read, omit-to-keep on write) and takes effect
/// immediately. Other scalar changes take effect on restart. Admin session required.
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/general")]
public class GeneralConfigController(GeneralConfigService general) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(GeneralConfigResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<GeneralConfigResponse>> Get(CancellationToken ct)
        => Ok(GeneralConfigResponse.From(await general.GetAsync(ct)));

    [HttpPut]
    [ProducesResponseType(typeof(GeneralConfigResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<GeneralConfigResponse>> Update([FromBody] GeneralConfigWrite write, CancellationToken ct)
    {
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_config", "A config body is required."));
        if (write.ConnectionBudget is < 1)
            return BadRequest(ErrorResponse.Of("invalid_config", "'connectionBudget' must be at least 1."));
        if (write.SessionTtlSeconds is < 1)
            return BadRequest(ErrorResponse.Of("invalid_config", "'sessionTtlSeconds' must be at least 1."));
        if (write.ConnectionBudget is > 1_000)
            return BadRequest(ErrorResponse.Of("invalid_config", "'connectionBudget' must not exceed 1000."));
        if (write.SessionTtlSeconds is > 2_592_000)
            return BadRequest(ErrorResponse.Of("invalid_config", "'sessionTtlSeconds' must not exceed 2592000."));
        if (write.EphemeralCacheSizeMb is < 1 or > 67_108_864)
            return BadRequest(ErrorResponse.Of(
                "invalid_config",
                "'ephemeralCacheSizeMb' must be between 1 and 67108864."));
        if (write.SearchCacheTtlSeconds is < 0 or > 3600)
            return BadRequest(ErrorResponse.Of("invalid_config", "'searchCacheTtlSeconds' must be between 0 and 3600."));
        if (write.SegmentCacheSizeMb is < 0 or > 1_048_576)
            return BadRequest(ErrorResponse.Of("invalid_config", "'segmentCacheSizeMb' is outside its allowed range."));
        if (write.TmdbApiKey?.Length > 4096 || Options.StreamarrOptionsValidator.ContainsControl(write.TmdbApiKey))
            return BadRequest(ErrorResponse.Of("invalid_config", "'tmdbApiKey' is too long or contains control characters."));

        var updated = await general.UpdateAsync(write, ct);
        return Ok(GeneralConfigResponse.From(updated));
    }
}
