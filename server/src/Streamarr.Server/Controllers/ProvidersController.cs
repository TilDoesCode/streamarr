using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Usenet provider config CRUD + connectivity test (BRIEF §6.2, DECISIONS.md #6).
/// The password is write-only: GETs return it masked; PUT omits-to-keep.
/// Admin session required (BRIEF §6.4).
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/providers")]
public class ProvidersController(ProviderConfigService providers, ProviderConnectionTester tester) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ProviderResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ProviderResponse>>> List(CancellationToken ct)
        => Ok((await providers.ListAsync(ct)).Select(ProviderResponse.From).ToArray());

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(ProviderResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderResponse>> Get(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_provider_id", "The provider id is invalid."));

        var entity = await providers.GetAsync(id, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."))
            : Ok(ProviderResponse.From(entity));
    }

    [HttpPost]
    [ProducesResponseType(typeof(ProviderResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ProviderResponse>> Create([FromBody] ProviderWrite write, CancellationToken ct)
    {
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_provider", "A request body is required."));
        if (!string.IsNullOrWhiteSpace(write.Id))
            return BadRequest(ErrorResponse.Of("invalid_provider", "'id' is server-generated and must be omitted."));
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await providers.CreateAsync(write, ct);
        return CreatedAtAction(nameof(Get), new { id = entity.Id }, ProviderResponse.From(entity));
    }

    [HttpPut("{id}")]
    [ProducesResponseType(typeof(ProviderResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderResponse>> Update(string id, [FromBody] ProviderWrite write, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_provider_id", "The provider id is invalid."));
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await providers.UpdateAsync(id, write, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."))
            : Ok(ProviderResponse.From(entity));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_provider_id", "The provider id is invalid."));

        return await providers.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."));
    }

    /// <summary>Atomically assigns contiguous priorities in the supplied full order.</summary>
    [HttpPut("order")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Reorder([FromBody] ReorderRequest request, CancellationToken ct)
    {
        if (request?.Ids is null || request.Ids.Any(InvalidId) ||
            request.Ids.Distinct(StringComparer.Ordinal).Count() != request.Ids.Count)
        {
            return BadRequest(ErrorResponse.Of("invalid_order", "'ids' must contain each provider id exactly once."));
        }

        return await providers.ReorderAsync(request.Ids, ct)
            ? NoContent()
            : BadRequest(ErrorResponse.Of("invalid_order", "'ids' must contain each provider id exactly once."));
    }

    /// <summary>Connect + AUTHINFO against the stored provider; report achievable connections.</summary>
    [HttpPost("{id}/test")]
    [ProducesResponseType(typeof(ProviderTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderTestResult>> Test(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_provider_id", "The provider id is invalid."));

        var entity = await providers.GetAsync(id, ct);
        if (entity is null)
            return NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."));

        return Ok(await tester.TestAsync(providers.ToProvider(entity), ct));
    }

    private static ErrorResponse? Validate(ProviderWrite write)
    {
        if (write is null || string.IsNullOrWhiteSpace(write.Name))
            return ErrorResponse.Of("invalid_provider", "A non-empty 'name' is required.");
        if (string.IsNullOrWhiteSpace(write.Host))
            return ErrorResponse.Of("invalid_provider", "A non-empty 'host' is required.");
        if (write.Name.Length > 128)
            return ErrorResponse.Of("invalid_provider", "'name' must not exceed 128 characters.");
        if (Options.StreamarrOptionsValidator.ContainsControl(write.Name))
            return ErrorResponse.Of("invalid_provider", "'name' must not contain control characters.");
        if (write.Id is { } suppliedId && InvalidId(suppliedId))
            return ErrorResponse.Of("invalid_provider", "'id' is invalid.");
        if (!Options.StreamarrOptionsValidator.IsValidHost(write.Host))
            return ErrorResponse.Of("invalid_provider", "'host' must be a valid hostname or IP address.");
        if (write.Port is < 1 or > 65535)
            return ErrorResponse.Of("invalid_provider", "'port' must be between 1 and 65535.");
        if (write.MaxConnections is < 1 or > 100)
            return ErrorResponse.Of("invalid_provider", "'maxConnections' must be between 1 and 100.");
        if (write.Priority is < 0 or > 100_000)
            return ErrorResponse.Of("invalid_provider", "'priority' must be between 0 and 100000.");
        if (write.Username?.Length > 512 || write.Password?.Length > 4096 ||
            Options.StreamarrOptionsValidator.ContainsControl(write.Username) ||
            Options.StreamarrOptionsValidator.ContainsControl(write.Password))
            return ErrorResponse.Of("invalid_provider", "Provider credentials are too long or contain control characters.");
        return null;
    }

    private static bool InvalidId(string id)
        => string.IsNullOrWhiteSpace(id) || id.Length > 128 ||
           Options.StreamarrOptionsValidator.ContainsControl(id);
}
