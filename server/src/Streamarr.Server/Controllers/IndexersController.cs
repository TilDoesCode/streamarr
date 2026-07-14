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
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IndexerResponse>> Get(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_indexer_id", "The indexer id is invalid."));

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
        if (write is null)
            return BadRequest(ErrorResponse.Of("invalid_indexer", "A request body is required."));
        if (!string.IsNullOrWhiteSpace(write.Id))
            return BadRequest(ErrorResponse.Of("invalid_indexer", "'id' is server-generated and must be omitted."));
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
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_indexer_id", "The indexer id is invalid."));
        if (Validate(write) is { } error)
            return BadRequest(error);

        var entity = await indexers.UpdateAsync(id, write, ct);
        return entity is null
            ? NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."))
            : Ok(IndexerResponse.From(entity));
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_indexer_id", "The indexer id is invalid."));

        return await indexers.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No indexer with id '{id}'."));
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
            return BadRequest(ErrorResponse.Of("invalid_order", "'ids' must contain each indexer id exactly once."));
        }

        return await indexers.ReorderAsync(request.Ids, ct)
            ? NoContent()
            : BadRequest(ErrorResponse.Of("invalid_order", "'ids' must contain each indexer id exactly once."));
    }

    /// <summary>Run a <c>t=caps</c> roundtrip against the stored indexer, reporting latency.</summary>
    [HttpPost("{id}/test")]
    [ProducesResponseType(typeof(IndexerTestResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<IndexerTestResult>> Test(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_indexer_id", "The indexer id is invalid."));

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
        if (write.Name.Length > 128)
            return ErrorResponse.Of("invalid_indexer", "'name' must not exceed 128 characters.");
        if (Options.StreamarrOptionsValidator.ContainsControl(write.Name))
            return ErrorResponse.Of("invalid_indexer", "'name' must not contain control characters.");
        if (write.Id is { } suppliedId && InvalidId(suppliedId))
            return ErrorResponse.Of("invalid_indexer", "'id' is invalid.");
        if (!Options.StreamarrOptionsValidator.IsHttpUrl(write.BaseUrl))
            return ErrorResponse.Of("invalid_indexer", "'baseUrl' must be an absolute HTTP(S) URL without embedded credentials.");
        if (write.ApiKey?.Length > 4096 || Options.StreamarrOptionsValidator.ContainsControl(write.ApiKey))
            return ErrorResponse.Of("invalid_indexer", "'apiKey' is too long or contains control characters.");
        if (write.Categories is { Count: > 100 } || write.Categories?.Any(c => c is < 0 or > 999_999) == true)
            return ErrorResponse.Of("invalid_indexer", "'categories' contains too many or invalid category ids.");
        if (write.AllowedDownloadHosts is { Count: > 32 })
            return ErrorResponse.Of("invalid_indexer", "'allowedDownloadHosts' must not exceed 32 hosts.");
        if (write.AllowedDownloadHosts?.Any(h => !IsValidHost(h)) == true)
            return ErrorResponse.Of("invalid_indexer", "'allowedDownloadHosts' contains an invalid hostname (host only, no scheme, port or path).");
        if (write.Priority is < 0 or > 100_000)
            return ErrorResponse.Of("invalid_indexer", "'priority' must be between 0 and 100000.");
        return null;
    }

    private static bool InvalidId(string id)
        => string.IsNullOrWhiteSpace(id) || id.Length > 128 ||
           Options.StreamarrOptionsValidator.ContainsControl(id);

    /// <summary>
    /// A bare hostname (DNS name, IPv4 or IPv6) — no scheme, port, path or credentials.
    /// <see cref="Uri.CheckHostName"/> rejects anything that isn't a well-formed host.
    /// </summary>
    private static bool IsValidHost(string? host)
        => !string.IsNullOrWhiteSpace(host)
           && host.Length <= 253
           && !Options.StreamarrOptionsValidator.ContainsControl(host)
           && Uri.CheckHostName(host) != UriHostNameType.Unknown;
}
