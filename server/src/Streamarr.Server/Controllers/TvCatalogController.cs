using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>Lazy TV series → season → episode catalog endpoints.</summary>
[ApiController]
[Route("api/v1/tv")]
public sealed class TvCatalogController(
    TvCatalogService catalog,
    SearchConcurrencyGate searchGate) : ControllerBase
{
    [HttpGet("search")]
    [ProducesResponseType(typeof(TvSeriesSearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<TvSeriesSearchResponse>> Search(
        [FromQuery] string? q,
        [FromQuery] int limit = TvCatalogService.MaxSeriesCandidates,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(q))
            return BadRequest(ErrorResponse.Of("missing_query", "Provide 'q'."));
        var query = q.Trim();
        if (query.Length > 256 || query.Any(char.IsControl))
            return BadRequest(ErrorResponse.Of("invalid_query", "'q' must be at most 256 printable characters."));
        if (limit is < 1 or > TvCatalogService.MaxSeriesCandidates)
            return BadRequest(ErrorResponse.Of("invalid_query", $"'limit' must be between 1 and {TvCatalogService.MaxSeriesCandidates}."));

        return Ok(await catalog.SearchAsync(query, limit, cancellationToken));
    }

    [HttpGet("{tmdbId:int}")]
    [ProducesResponseType(typeof(TvSeriesDetailsResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TvSeriesDetailsResponse>> Series(
        int tmdbId,
        CancellationToken cancellationToken)
    {
        if (tmdbId <= 0)
            return NotFound(ErrorResponse.Of("series_not_found", "The TV series was not found."));
        var result = await catalog.GetSeriesAsync(tmdbId, cancellationToken);
        return result is null
            ? NotFound(ErrorResponse.Of("series_not_found", "The TV series was not found."))
            : Ok(result);
    }

    [HttpGet("{tmdbId:int}/seasons/{seasonNumber:int}")]
    [ProducesResponseType(typeof(TvSeasonDetailsResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<TvSeasonDetailsResponse>> Season(
        int tmdbId,
        int seasonNumber,
        [FromQuery] string? profileId,
        CancellationToken cancellationToken)
    {
        if (tmdbId <= 0 || seasonNumber < 0 || profileId?.Length > 128)
            return NotFound(ErrorResponse.Of("season_not_found", "The TV season was not found."));

        if (!await searchGate.TryEnterAsync(cancellationToken))
        {
            Response.Headers.RetryAfter = "1";
            return StatusCode(
                StatusCodes.Status429TooManyRequests,
                ErrorResponse.Of("capacity_reached", "Search capacity is currently reached; retry shortly."));
        }

        try
        {
            var result = await catalog.GetSeasonAsync(
                tmdbId,
                seasonNumber,
                profileId,
                cancellationToken);
            return result is null
                ? NotFound(ErrorResponse.Of("season_not_found", "The TV season was not found."))
                : Ok(result);
        }
        finally
        {
            searchGate.Exit();
        }
    }
}
