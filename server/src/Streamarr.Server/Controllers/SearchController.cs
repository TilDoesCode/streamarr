using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Ranking;
using Streamarr.Core.Search;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/search + POST /api/v1/debug/search (BRIEF §6.2). Both run the identical
/// pipeline via <see cref="SearchService"/>; the debug endpoint just projects more of
/// the result (parsed fields, score breakdown, rejection reasons, indexer diagnostics).
/// Neither ever exposes an NZB URL or indexer API key.
/// </summary>
[ApiController]
[Route("api/v1")]
public class SearchController(SearchService searchService) : ControllerBase
{
    [HttpGet("search")]
    [ProducesResponseType(typeof(SearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<SearchResponse>> Search(
        [FromQuery] string? q,
        [FromQuery] string? type,
        [FromQuery] int? season,
        [FromQuery] int? episode,
        [FromQuery] string? imdbId,
        [FromQuery] int? tmdbId,
        [FromQuery] string? profileId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(q) && string.IsNullOrWhiteSpace(imdbId) && tmdbId is null)
            return BadRequest(ErrorResponse.Of("missing_query", "Provide 'q', 'imdbId' or 'tmdbId'."));

        var query = new SearchQuery
        {
            Q = q ?? string.Empty,
            Type = type,
            Season = season,
            Episode = episode,
            ImdbId = imdbId,
            TmdbId = tmdbId,
            ProfileId = profileId,
        };

        var aggregation = await searchService.SearchAsync(query, cancellationToken);
        return Ok(new SearchResponse { Results = aggregation.Works.Select(ToWorkDto).ToArray() });
    }

    // /debug/search exposes rejected releases, parsed fields, and score breakdowns —
    // a tuning/dev tool, so it is admin-only; machine keys cannot reach it (BRIEF §6.4).
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [HttpPost("debug/search")]
    [ProducesResponseType(typeof(DebugSearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<DebugSearchResponse>> DebugSearch([FromBody] DebugSearchRequest request, CancellationToken cancellationToken)
    {
        if (request is null || (string.IsNullOrWhiteSpace(request.Q) && string.IsNullOrWhiteSpace(request.ImdbId) && request.TmdbId is null))
            return BadRequest(ErrorResponse.Of("missing_query", "Provide 'q', 'imdbId' or 'tmdbId'."));

        var query = new SearchQuery
        {
            Q = request.Q ?? string.Empty,
            Type = request.Type,
            Season = request.Season,
            Episode = request.Episode,
            ImdbId = request.ImdbId,
            TmdbId = request.TmdbId,
            ProfileId = request.ProfileId,
        };

        var aggregation = await searchService.SearchAsync(query, cancellationToken);
        return Ok(ToDebugResponse(aggregation));
    }

    // ---- /search mapping -----------------------------------------------------------

    private static WorkDto ToWorkDto(Work work) => new()
    {
        WorkId = work.WorkId,
        MediaType = MediaTypeSlug(work.MediaType),
        Title = work.Title,
        Year = work.Year,
        TmdbId = work.TmdbId,
        ImdbId = work.ImdbId,
        Overview = work.Overview,
        PosterUrl = work.PosterUrl,
        BackdropUrl = work.BackdropUrl,
        RuntimeMinutes = work.RuntimeMinutes,
        Season = work.Season,
        Episode = work.Episode,
        Releases = work.Releases.Select(ToReleaseDto).ToArray(),
    };

    private static ReleaseDto ToReleaseDto(Release release) => new()
    {
        ReleaseId = release.ReleaseId,
        Title = release.Title,
        Indexer = release.Indexer,
        SizeBytes = release.SizeBytes,
        Quality = ToQualityDto(release.Quality),
        Languages = release.Languages,
        ReleaseGroup = release.ReleaseGroup,
        AgeDays = release.AgeDays,
        Grabs = release.Grabs,
        Score = release.Score,
        Rejected = release.Rejected,
        RejectionReasons = release.RejectionReasons,
        Health = release.Health.ToString().ToLowerInvariant(),
    };

    private static QualityDto ToQualityDto(QualityInfo quality) => new()
    {
        Resolution = quality.Resolution,
        Source = quality.Source,
        Codec = quality.Codec,
        Hdr = quality.Hdr,
        Audio = quality.Audio,
        Edition = quality.Edition,
        Proper = quality.Proper,
        Repack = quality.Repack,
    };

    // ---- /debug/search mapping -----------------------------------------------------

    private static DebugSearchResponse ToDebugResponse(SearchAggregation aggregation)
    {
        var byWork = aggregation.Releases
            .GroupBy(r => r.WorkId)
            .ToDictionary(g => g.Key, g => g.ToArray());

        var results = aggregation.Works
            .Select(work => ToDebugWorkDto(work, byWork.GetValueOrDefault(work.WorkId, [])))
            .ToArray();

        return new DebugSearchResponse
        {
            Results = results,
            Indexers = aggregation.Outcomes.Select(ToDiagnosticDto).ToArray(),
        };
    }

    private static DebugWorkDto ToDebugWorkDto(Work work, IReadOnlyList<EvaluatedRelease> releases) => new()
    {
        WorkId = work.WorkId,
        MediaType = MediaTypeSlug(work.MediaType),
        Title = work.Title,
        Year = work.Year,
        TmdbId = work.TmdbId,
        ImdbId = work.ImdbId,
        RuntimeMinutes = work.RuntimeMinutes,
        Season = work.Season,
        Episode = work.Episode,
        // Present debug releases in the same ranked order the work exposes them.
        Releases = OrderByWork(work, releases).Select(ToDebugReleaseDto).ToArray(),
    };

    private static IEnumerable<EvaluatedRelease> OrderByWork(Work work, IReadOnlyList<EvaluatedRelease> releases)
    {
        var order = work.Releases
            .Select((r, i) => (r.ReleaseId, i))
            .ToDictionary(x => x.ReleaseId, x => x.i);
        return releases.OrderBy(e => order.GetValueOrDefault(e.Release.ReleaseId, int.MaxValue));
    }

    private static DebugReleaseDto ToDebugReleaseDto(EvaluatedRelease evaluated)
    {
        var release = evaluated.Release;
        return new DebugReleaseDto
        {
            ReleaseId = release.ReleaseId,
            Title = release.Title,
            Indexer = release.Indexer,
            SizeBytes = release.SizeBytes,
            AgeDays = release.AgeDays,
            Grabs = release.Grabs,
            Score = evaluated.Assessment.Score.Total,
            Rejected = evaluated.Assessment.Rejected,
            Health = release.Health.ToString().ToLowerInvariant(),
            Parsed = ToParsedFieldsDto(evaluated.Parsed),
            ScoreBreakdown = evaluated.Assessment.Score.Breakdown
                .Select(l => new ScoreLineDto { Rule = l.Rule, Points = l.Points }).ToArray(),
            Rejections = evaluated.Assessment.Rejections
                .Select(r => new RejectionDto { Code = r.CodeSlug, Message = r.Message }).ToArray(),
        };
    }

    private static ParsedFieldsDto ToParsedFieldsDto(ParsedReleaseInfo parsed) => new()
    {
        Title = parsed.Title,
        Year = parsed.Year,
        MediaType = parsed.MediaType.ToString().ToLowerInvariant(),
        Resolution = parsed.Resolution,
        Source = parsed.Source,
        VideoCodec = parsed.VideoCodec,
        Hdr = parsed.Hdr,
        AudioCodec = parsed.AudioCodec,
        AudioChannels = parsed.AudioChannels,
        Atmos = parsed.Atmos,
        Edition = parsed.Edition,
        ReleaseGroup = parsed.ReleaseGroup,
        Proper = parsed.Proper,
        Repack = parsed.Repack,
        Languages = parsed.Languages,
        Season = parsed.Season,
        Episodes = parsed.Episodes,
        AbsoluteEpisodes = parsed.AbsoluteEpisodes,
        SeasonPack = parsed.SeasonPack,
        AirDate = parsed.AirDate,
    };

    private static IndexerDiagnosticDto ToDiagnosticDto(IndexerOutcome outcome) => new()
    {
        IndexerId = outcome.IndexerId,
        IndexerName = outcome.IndexerName,
        Status = outcome.Status.ToString().ToLowerInvariant(),
        ItemCount = outcome.ItemCount,
        ElapsedMs = outcome.Elapsed.TotalMilliseconds,
        Error = outcome.Error,
    };

    private static string MediaTypeSlug(MediaType type) => type == MediaType.Tv ? "tv" : "movie";
}
