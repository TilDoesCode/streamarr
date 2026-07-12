using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// General config GET/PUT (BRIEF §6.2): TMDB key, TTLs, cache sizes, NNTP budget. The
/// TMDB key is write-only (masked on read, omit-to-keep on write). Scalar changes take
/// effect on restart.
/// </summary>
[ApiController]
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

        var updated = await general.UpdateAsync(write, ct);
        return Ok(GeneralConfigResponse.From(updated));
    }
}
