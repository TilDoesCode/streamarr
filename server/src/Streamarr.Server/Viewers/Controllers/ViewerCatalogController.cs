using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Media;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Viewers.Controllers;

/// <summary>What a viewer can watch: TMDB search and home rows, title details with watch state, and ranked versions.</summary>
[ApiController]
[Route("api/v1/viewer/catalog")]
[RequiresModule(ViewerAuth.ModuleId)]
[Authorize(Policy = ViewerAuth.Policy)]
[ViewerProblemFilter]
[ViewerPasswordChangeFilter]
[ViewerModelStateFilter]
[ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
[ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status401Unauthorized)]
public sealed class ViewerCatalogController(ViewerCatalogService catalog, ViewerAccountService accounts) : ControllerBase
{
    /// <summary>TMDB movie/series candidates for a query (no indexer search); titles the viewer may not watch are hidden.</summary>
    [HttpGet("search")]
    [ProducesResponseType(typeof(CatalogSearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogSearchResponse>> Search(
        [FromQuery] string? q,
        [FromQuery] string? type,
        [FromQuery] int limit = ViewerCatalogService.MaxSearchResults,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(q))
            throw ViewerProblem.BadRequest("missing_query", "Provide 'q'.");
        var query = q.Trim();
        if (query.Length > 256 || query.Any(char.IsControl))
            throw ViewerProblem.BadRequest("invalid_query", "'q' must be at most 256 printable characters.");
        MediaType? mediaType = type?.Trim().ToLowerInvariant() switch
        {
            null or "" or "any" => null,
            "movie" => MediaType.Movie,
            "tv" or "series" => MediaType.Tv,
            _ => throw ViewerProblem.BadRequest("invalid_query", "'type' must be movie, tv or any."),
        };
        if (limit is < 1 or > ViewerCatalogService.MaxSearchResults)
            throw ViewerProblem.BadRequest("invalid_query", $"'limit' must be between 1 and {ViewerCatalogService.MaxSearchResults}.");
        return Ok(await catalog.SearchAsync(await ViewerAsync(ct), query, mediaType, limit, ct));
    }

    /// <summary>Home rows (trending and popular movies and series) from TMDB, cached for hours.</summary>
    [HttpGet("discover")]
    [ProducesResponseType(typeof(CatalogDiscoverResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogDiscoverResponse>> Discover(CancellationToken ct)
        => Ok(await catalog.DiscoverAsync(await ViewerAsync(ct), ct));

    /// <summary>Movie details with the viewer's watch state and age-gate decision.</summary>
    [HttpGet("movies/{tmdbId}")]
    [ProducesResponseType(typeof(CatalogMovieResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogMovieResponse>> Movie(int tmdbId, CancellationToken ct)
    {
        if (tmdbId <= 0)
            throw ViewerProblem.NotFound("title_not_found", "The title was not found.");
        return Ok(await catalog.MovieAsync(await ViewerAsync(ct), tmdbId, ct));
    }

    /// <summary>Series details, season summaries and the viewer's progress (next episode, played counts).</summary>
    [HttpGet("series/{tmdbId}")]
    [ProducesResponseType(typeof(CatalogSeriesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogSeriesResponse>> Series(int tmdbId, CancellationToken ct)
    {
        if (tmdbId <= 0)
            throw ViewerProblem.NotFound("title_not_found", "The title was not found.");
        return Ok(await catalog.SeriesAsync(await ViewerAsync(ct), tmdbId, ct));
    }

    /// <summary>Season episodes with watch state; <c>availability=true</c> adds version counts (cached indexer search, <c>refresh=true</c> repeats it).</summary>
    [HttpGet("series/{tmdbId}/seasons/{seasonNumber}")]
    [ProducesResponseType(typeof(CatalogSeasonResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogSeasonResponse>> Season(
        int tmdbId,
        int seasonNumber,
        [FromQuery] bool availability = false,
        [FromQuery] bool refresh = false,
        CancellationToken ct = default)
    {
        if (tmdbId <= 0)
            throw ViewerProblem.NotFound("title_not_found", "The title was not found.");
        if (seasonNumber is < 0 or > 100_000)
            throw ViewerProblem.NotFound("season_not_found", "The season was not found.");
        return Ok(await catalog.SeasonAsync(await ViewerAsync(ct), tmdbId, seasonNumber, availability, refresh, ct));
    }

    /// <summary>Ranked versions (cached indexer search, <c>refresh=true</c> repeats it); a <c>videoCodecs</c> device profile adds <c>predictedMethod</c>.</summary>
    [HttpGet("works/{workId}/versions")]
    [ProducesResponseType(typeof(CatalogVersionsResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status403Forbidden)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogVersionsResponse>> Versions(
        string workId,
        [FromQuery] bool refresh = false,
        [FromQuery] string? videoCodecs = null,
        [FromQuery] string? audioCodecs = null,
        [FromQuery] string? containers = null,
        [FromQuery] string? hdrFormats = null,
        [FromQuery] bool? supports10Bit = null,
        [FromQuery] int? maxAudioChannels = null,
        [FromQuery] int? maxHeight = null,
        [FromQuery] int? maxBitrateKbps = null,
        CancellationToken ct = default)
    {
        var key = ViewerMappings.RequireWork(workId, playableOnly: true);
        DeviceHints? device = null;
        if (List(videoCodecs) is { Count: > 0 } video)
        {
            var client = new ClientProfile
            {
                VideoCodecs = video,
                AudioCodecs = List(audioCodecs) ?? ClientProfile.Default.AudioCodecs,
                Containers = List(containers) ?? ClientProfile.Default.Containers,
                HdrFormats = List(hdrFormats),
                SupportsHdr = List(hdrFormats) is { Count: > 0 },
                Supports10Bit = supports10Bit ?? List(hdrFormats) is { Count: > 0 },
                MaxAudioChannels = Math.Clamp(maxAudioChannels ?? 2, 1, 8),
            };
            device = new DeviceHints(client, new TranscodeLimits(
                maxHeight is { } h ? Math.Clamp(h, 144, 4320) : null,
                maxBitrateKbps is { } b ? Math.Clamp(b, 300, 200_000) : null));
        }
        return Ok(await catalog.VersionsAsync(await ViewerAsync(ct), key, refresh, device, ct));
    }

    private async Task<Persistence.Entities.ViewerEntity> ViewerAsync(CancellationToken ct)
        => await accounts.GetAsync(User.ViewerId(), ct);

    private static IReadOnlyList<string>? List(string? csv)
    {
        if (string.IsNullOrWhiteSpace(csv))
            return null;
        if (csv.Length > 512 || csv.Any(char.IsControl))
            throw ViewerProblem.BadRequest("invalid_device_profile", "Device profile lists must be short comma-separated names.");
        return csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(v => v.Length <= 32)
            .Select(v => v.ToLowerInvariant())
            .Distinct(StringComparer.Ordinal)
            .Take(16)
            .ToList();
    }
}
