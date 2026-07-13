using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Indexer config CRUD + connectivity test (BRIEF §6.2). Secrets are write-only:
/// GETs return a masked API key; PUT omits-to-keep. Admin session required (BRIEF §6.4).
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/indexers")]
public class IndexersController(IndexerConfigService indexers, IndexerCapsTester tester) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<IndexerResponse>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<IndexerResponse>>> List(CancellationToken ct)
        => Ok((await indexers.ListAsync(ct)).Select(IndexerResponse.From).ToArray());

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(IndexerResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IndexerResponse>> Get(string id, CancellationToken ct)
    {
        var entity = await indexers.GetAsync(id, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."))
            : Ok(IndexerResponse.From(entity));
    }

    [HttpPost]
    [ProducesResponseType(typeof(IndexerResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<IndexerResponse>> Create([FromBody] IndexerWrite write, CancellationToken ct)
    {
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await indexers.CreateAsync(write, ct);
        return CreatedAtAction(nameof(Get), new { id = entity.Id }, IndexerResponse.From(entity));
    }

    [HttpPut("{id}")]
    [ProducesResponseType(typeof(IndexerResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IndexerResponse>> Update(string id, [FromBody] IndexerWrite write, CancellationToken ct)
    {
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await indexers.UpdateAsync(id, write, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."))
            : Ok(IndexerResponse.From(entity));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
        => await indexers.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."));

    /// <summary>Run a <c>t=caps</c> roundtrip against the stored indexer, reporting latency.</summary>
    [HttpPost("{id}/test")]
    [ProducesResponseType(typeof(IndexerTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IndexerTestResult>> Test(string id, CancellationToken ct)
    {
        var entity = await indexers.GetAsync(id, ct);
        if (entity is null)
            return NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."));

        return Ok(await tester.TestAsync(indexers.ToConfig(entity), ct));
    }

    private static ErrorResponse? Validate(IndexerWrite write)
    {
        if (write is null || string.IsNullOrWhiteSpace(write.Name))
            return ErrorResponse.Of("invalid_indexer", "A non-empty 'name' is required.");
        if (string.IsNullOrWhiteSpace(write.BaseUrl))
            return ErrorResponse.Of("invalid_indexer", "A non-empty 'baseUrl' is required.");
        return null;
    }
}
