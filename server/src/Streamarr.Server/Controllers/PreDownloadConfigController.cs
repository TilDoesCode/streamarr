using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;

namespace Streamarr.Server.Controllers;

[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/pre-download")]
public sealed class PreDownloadConfigController(PreDownloadConfigService config) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(PreDownloadConfigResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<PreDownloadConfigResponse>> Get(CancellationToken ct)
        => Ok(PreDownloadConfigResponse.From(await config.GetAsync(ct)));

    [HttpPut]
    [ProducesResponseType(typeof(PreDownloadConfigResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<PreDownloadConfigResponse>> Update(
        [FromBody] PreDownloadConfigWrite write,
        CancellationToken ct)
    {
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_pre_download_config", "A config body is required."));
        if (write.CurrentFileThresholdSeconds is < PreDownloadOptions.MinCurrentFileThresholdSeconds
            or > PreDownloadOptions.MaxCurrentFileThresholdSeconds)
        {
            return Invalid("'currentFileThresholdSeconds' must be between 0 and 3600.");
        }
        if (write.NextEpisodeThresholdPercent is < PreDownloadOptions.MinNextEpisodeThresholdPercent
            or > PreDownloadOptions.MaxNextEpisodeThresholdPercent)
        {
            return Invalid("'nextEpisodeThresholdPercent' must be between 1 and 100.");
        }
        if (write.NextEpisodeReleaseSimilarityThresholdPercent is
            < PreDownloadOptions.MinNextEpisodeReleaseSimilarityThresholdPercent
            or > PreDownloadOptions.MaxNextEpisodeReleaseSimilarityThresholdPercent)
        {
            return Invalid("'nextEpisodeReleaseSimilarityThresholdPercent' must be between 0 and 100.");
        }
        if (write.MaxConcurrentDownloads is < PreDownloadOptions.MinimumConcurrentDownloads
            or > PreDownloadOptions.MaximumConcurrentDownloads)
        {
            return Invalid("'maxConcurrentDownloads' must be between 1 and 8.");
        }

        return Ok(PreDownloadConfigResponse.From(await config.UpdateAsync(write, ct)));
    }

    private BadRequestObjectResult Invalid(string message)
        => BadRequest(ErrorResponse.Of("invalid_pre_download_config", message));
}
