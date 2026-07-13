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
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderResponse>> Get(string id, CancellationToken ct)
    {
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
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await providers.UpdateAsync(id, write, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."))
            : Ok(ProviderResponse.From(entity));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
        => await providers.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No provider with id '{id}'."));

    /// <summary>Connect + AUTHINFO against the stored provider; report achievable connections.</summary>
    [HttpPost("{id}/test")]
    [ProducesResponseType(typeof(ProviderTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProviderTestResult>> Test(string id, CancellationToken ct)
    {
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
        return null;
    }
}
