using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Ranking;
using Streamarr.Core.Search;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>
/// GET /api/v1/search + POST /api/v1/debug/search (BRIEF §6.2). Both run the identical
/// pipeline via <see cref="SearchService"/>; the debug endpoint also preserves raw buckets
/// and projects parsed fields, score breakdown, rejection reasons, and indexer diagnostics.
/// Neither ever exposes an NZB URL or indexer API key.
/// </summary>
[ApiController]
[Route("api/v1")]
public class SearchController(
    SearchService searchService,
    SearchConcurrencyGate searchGate,
    GeneralConfigService generalConfig) : ControllerBase
{
    [HttpGet("search")]
    [ProducesResponseType(typeof(SearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
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
        if (ValidateQuery(q, type, season, episode, imdbId, tmdbId, profileId) is { } validation)
            return BadRequest(validation);

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

        if (!await searchGate.TryEnterAsync(cancellationToken))
            return SearchCapacityReached();

        try
        {
            var aggregation = await searchService.SearchAsync(query, cancellationToken);
            var config = await generalConfig.GetAsync(cancellationToken);
            var addStreamarrBadge = config.AddStreamarrBadge;
            var addReleaseScoreToName = config.AddReleaseScoreToName;
            return Ok(new SearchResponse
            {
                // Public discovery is an availability promise: expose only works with at least
                // one release accepted by the selected quality profile, and never offer rejected
                // versions for playback. /debug/search retains the complete assessment.
                Results = aggregation.Works
                    .Select(work => ToSearchWorkDto(work, addStreamarrBadge, addReleaseScoreToName))
                    .Where(work => work is not null)
                    .Cast<WorkDto>()
                    .ToArray(),
            });
        }
        finally
        {
            searchGate.Exit();
        }
    }

    // /debug/search exposes rejected releases, parsed fields, and score breakdowns —
    // a tuning/dev tool, so it is admin-only; machine keys cannot reach it (BRIEF §6.4).
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [HttpPost("debug/search")]
    [ProducesResponseType(typeof(DebugSearchResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<DebugSearchResponse>> DebugSearch([FromBody] DebugSearchRequest request, CancellationToken cancellationToken)
    {
        if (request is null || (string.IsNullOrWhiteSpace(request.Q) && string.IsNullOrWhiteSpace(request.ImdbId) && request.TmdbId is null))
            return BadRequest(ErrorResponse.Of("missing_query", "Provide 'q', 'imdbId' or 'tmdbId'."));
        if (ValidateQuery(request.Q, request.Type, request.Season, request.Episode,
                request.ImdbId, request.TmdbId, request.ProfileId) is { } validation)
            return BadRequest(validation);
        if (request.Profile is not null && ProfilesController.ValidateProfile(request.Profile) is { } profileValidation)
            return BadRequest(profileValidation);

        var query = new SearchQuery
        {
            Q = request.Q ?? string.Empty,
            Type = request.Type,
            Season = request.Season,
            Episode = request.Episode,
            ImdbId = request.ImdbId,
            TmdbId = request.TmdbId,
            ProfileId = request.ProfileId,
            DraftProfile = request.Profile,
            PreserveDiagnosticBuckets = true,
        };

        if (!await searchGate.TryEnterAsync(cancellationToken))
            return SearchCapacityReached();

        try
        {
            var aggregation = await searchService.SearchAsync(query, cancellationToken);
            return Ok(ToDebugResponse(aggregation));
        }
        finally
        {
            searchGate.Exit();
        }
    }

    private ObjectResult SearchCapacityReached()
    {
        Response.Headers.RetryAfter = "1";
        return StatusCode(
            StatusCodes.Status429TooManyRequests,
            ErrorResponse.Of("capacity_reached", "Search capacity is currently reached; retry shortly."));
    }

    // ---- /search mapping -----------------------------------------------------------

    private static WorkDto? ToSearchWorkDto(
        Work work,
        bool addStreamarrBadge,
        bool addReleaseScoreToName)
    {
        // Public discovery is semantic: unidentified parser buckets belong only in the
        // admin debug response. This prevents raw substring hits from appearing as fake
        // movies/episodes (and without artwork) when TMDB is unavailable or finds no match.
        if (work.TmdbId is null)
            return null;
        var accepted = work.Releases.Where(release => !release.Rejected).ToArray();
        return accepted.Length == 0
            ? null
            : ToWorkDto(work, accepted, addStreamarrBadge, addReleaseScoreToName);
    }

    private static WorkDto ToWorkDto(
        Work work,
        IReadOnlyList<Release> releases,
        bool addStreamarrBadge,
        bool addReleaseScoreToName) => new()
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
        OriginalTitle = work.OriginalTitle,
        Tagline = work.Tagline,
        OfficialRating = work.OfficialRating,
        CommunityRating = work.CommunityRating,
        Genres = work.Genres,
        Studios = work.Studios,
        ProductionLocations = work.ProductionLocations,
        People = work.People,
        TrailerUrl = work.TrailerUrl,
        AddStreamarrBadge = addStreamarrBadge,
        Season = work.Season,
        Episode = work.Episode,
        Releases = releases.Select(release => ToReleaseDto(release, addReleaseScoreToName)).ToArray(),
    };

    private static ReleaseDto ToReleaseDto(Release release, bool addScoreToName) => new()
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
        AddScoreToName = addScoreToName,
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

    private static ErrorResponse? ValidateQuery(
        string? q,
        string? type,
        int? season,
        int? episode,
        string? imdbId,
        int? tmdbId,
        string? profileId)
    {
        if (q?.Length > 256 || imdbId?.Length > 32 || profileId?.Length > 128)
            return ErrorResponse.Of("invalid_query", "One or more query values exceed their length limit.");
        if (type is not null && type.Trim().ToLowerInvariant() is not ("movie" or "tv" or "any"))
            return ErrorResponse.Of("invalid_query", "'type' must be movie, tv, or any.");
        if (season is < 0 or > 100_000 || episode is < 0 or > 100_000 || tmdbId is <= 0)
            return ErrorResponse.Of("invalid_query", "Season, episode, and TMDB identifiers must be within valid ranges.");
        if (imdbId is { Length: > 0 } id &&
            (!id.StartsWith("tt", StringComparison.OrdinalIgnoreCase) || id.Length < 3 ||
             !id.AsSpan(2).ToString().All(char.IsAsciiDigit)))
            return ErrorResponse.Of("invalid_query", "'imdbId' must have the form tt followed by digits.");
        return null;
    }
}
