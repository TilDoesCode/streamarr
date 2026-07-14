using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Machine API key management (BRIEF §6.4 / §9.1). The plaintext token is returned only
/// once, at creation; thereafter only its prefix and metadata are visible. Keys are
/// revoked (soft-deleted), not hard-deleted, so past issuance stays auditable.
/// Admin session required — machine keys cannot mint or revoke keys (BRIEF §6.4).
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/apikeys")]
public class ApiKeysController(ApiKeyService apiKeys) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ApiKeyResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ApiKeyResponse>>> List(CancellationToken ct)
        => Ok((await apiKeys.ListAsync(ct)).Select(ApiKeyResponse.From).ToArray());

    [HttpPost]
    [ProducesResponseType(typeof(CreatedApiKeyResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<CreatedApiKeyResponse>> Create([FromBody] CreateApiKeyRequest request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 128 ||
            request.Name.Any(char.IsControl))
            return BadRequest(ErrorResponse.Of("invalid_api_key", "A non-empty 'name' is required."));

        var (entity, token) = await apiKeys.CreateAsync(request.Name.Trim(), ct);
        return CreatedAtAction(nameof(List), null, new CreatedApiKeyResponse
        {
            Id = entity.Id,
            Name = entity.Name,
            Token = token,
        });
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Revoke(string id, CancellationToken ct)
        => string.IsNullOrWhiteSpace(id) || id.Length > 128 || id.Any(char.IsControl)
            ? BadRequest(ErrorResponse.Of("invalid_api_key", "A valid API key id is required."))
            : await apiKeys.RevokeAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No active API key with id '{id}'."));
}
