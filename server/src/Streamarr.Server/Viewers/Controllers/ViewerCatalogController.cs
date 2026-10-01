using Streamarr.Server.Viewers.Playback;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;
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

    /// <summary>One page of a Movies or Series library page (TMDB discover by genre and sort); titles the viewer may not watch are hidden.</summary>
    [HttpGet("browse")]
    [ProducesResponseType(typeof(CatalogBrowseResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogBrowseResponse>> Browse(
        [FromQuery] string? type,
        [FromQuery] int? genre = null,
        [FromQuery] string? sort = null,
        [FromQuery] int page = 1,
        CancellationToken ct = default)
    {
        var mediaType = BrowseType(type);
        if (genre is <= 0)
            throw ViewerProblem.BadRequest("invalid_query", "'genre' must be a positive TMDB genre id.");
        var order = sort?.Trim().ToLowerInvariant() switch
        {
            null or "" or "popular" => TmdbDiscoverSort.Popular,
            "top_rated" => TmdbDiscoverSort.TopRated,
            "newest" => TmdbDiscoverSort.Newest,
            _ => throw ViewerProblem.BadRequest("invalid_query", "'sort' must be popular, top_rated or newest."),
        };
        if (page is < 1 or > TmdbDiscoverQuery.MaxPage)
            throw ViewerProblem.BadRequest("invalid_query", $"'page' must be between 1 and {TmdbDiscoverQuery.MaxPage}.");
        return Ok(await catalog.BrowseAsync(await ViewerAsync(ct), new TmdbDiscoverQuery(mediaType, genre, order, page), ct));
    }

    /// <summary>TMDB genres of movies or series for the browse filter, cached for hours.</summary>
    [HttpGet("genres")]
    [ProducesResponseType(typeof(CatalogGenresResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<CatalogGenresResponse>> Genres([FromQuery] string? type, CancellationToken ct)
    {
        var mediaType = BrowseType(type);
        await ViewerAsync(ct);
        return Ok(await catalog.GenresAsync(mediaType, ct));
    }

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

    /// <summary>Ranked versions (cached indexer search, <c>refresh=true</c> repeats it); a <c>videoCodecs</c> device profile adds <c>predictedMethod</c> and orders by what plays without a server transcode.</summary>
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
        [FromQuery] bool vlcAvailable = false,
        [FromQuery] string? vlcVideoCodecs = null,
        [FromQuery] int? vlcMaxHeight = null,
        [FromQuery] string? vlcHdrFormats = null,
        [FromQuery] bool? vlcSupports10Bit = null,
        [FromQuery] bool? vlcHdrToneMapping = null,
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
        // an explicitly empty vlcHdrFormats binds as null, but means "none"
        var vlcHdr = vlcHdrFormats ?? (Request.Query.ContainsKey(nameof(vlcHdrFormats)) ? "" : null);
        var vlc = vlcAvailable ? VlcCaps(vlcVideoCodecs, vlcMaxHeight, vlcHdr, vlcSupports10Bit, vlcHdrToneMapping) : null;
        var caps = device is null ? null : DeviceCapsFor(device, vlc);
        return Ok(await catalog.VersionsAsync(await ViewerAsync(ct), key, refresh, device, ct, caps));
    }

    /// <summary>The VLC engine of a versions request: libVLC's defaults narrowed by the <c>vlc*</c> limits the client sent.</summary>
    internal static EngineCaps VlcCaps(string? videoCodecs, int? maxHeight, string? hdrFormats, bool? supports10Bit, bool? hdrToneMapping)
    {
        var defaults = EngineCaps.DefaultVlc;
        if (videoCodecs is null && maxHeight is null && hdrFormats is null && supports10Bit is null && hdrToneMapping is null)
            return defaults;
        if (maxHeight is < 144 or > 4320)
            throw ViewerProblem.BadRequest("invalid_device_profile", "'vlcMaxHeight' must be between 144 and 4320.");
        var hdr = hdrFormats is null ? null : HdrList(hdrFormats);
        var entries = List(videoCodecs)?.Select(entry =>
        {
            var parts = entry.Split(':', 2);
            int? height = null;
            if (parts.Length == 2)
                height = int.TryParse(parts[1], out var h) && h is >= 144 and <= 4320 ? h
                    : throw ViewerProblem.BadRequest("invalid_device_profile", "'vlcVideoCodecs' entries are codec or codec:maxHeight (144-4320).");
            var codec = DeviceNames.Video(parts[0]);
            return defaults.VideoFor(codec) is not null ? (Codec: codec, Height: height)
                : throw ViewerProblem.BadRequest("invalid_device_profile", $"'vlcVideoCodecs' names an unknown codec '{parts[0]}'; known: {string.Join(", ", defaults.Video.Select(v => v.Codec))}.");
        }).ToList() ?? defaults.Video.Select(v => (v.Codec, Height: (int?)null)).ToList();
        var video = entries.DistinctBy(e => e.Codec).Select(e =>
        {
            var known = defaults.VideoFor(e.Codec);
            var depth = supports10Bit is false ? 8 : known?.MaxBitDepth ?? (e.Codec is "hevc" or "av1" or "vp9" ? 10 : 8);
            var formats = depth < 10 ? [] : hdr ?? known?.HdrFormats ?? [];
            return new VideoCaps(e.Codec, null, e.Height ?? maxHeight, depth, formats);
        }).ToList();
        return defaults with { Video = video, ToneMapsHdr = hdrToneMapping ?? defaults.ToneMapsHdr };
    }

    /// <summary>The HDR formats VLC renders: <c>none</c> or an empty value means none at all.</summary>
    private static List<string> HdrList(string hdrFormats)
    {
        var list = List(hdrFormats) ?? [];
        if (list.Contains("none"))
        {
            return list.Count == 1 ? []
                : throw ViewerProblem.BadRequest("invalid_device_profile", "'vlcHdrFormats=none' cannot be combined with HDR formats.");
        }
        return list.Select(h => h == "dv" ? "dolbyvision" : h).ToList();
    }

    private static DeviceCaps DeviceCapsFor(DeviceHints hints, EngineCaps? vlc)
    {
        var client = hints.Client;
        var depth = client.Supports10Bit ? 10 : 8;
        var hdr = (client.HdrFormats ?? []).Select(h => h == "dv" ? "dolbyvision" : h).ToList();
        var native = new EngineCaps(
            EngineCaps.Native,
            client.Containers.Select(DeviceNames.Container).Distinct().ToList(),
            client.VideoCodecs.Select(DeviceNames.Video).Distinct()
                .Select(c => new VideoCaps(c, null, hints.Limits.MaxHeight, c == "h264" ? 8 : depth, c == "h264" ? [] : hdr)).ToList(),
            client.AudioCodecs.Select(DeviceNames.Audio).Distinct().Select(c => new AudioCaps(c, null, false)).ToList(),
            null,
            true,
            client.MaxAudioChannels);
        return new DeviceCaps("web", native, vlc, hints.Limits.MaxBitrateKbps);
    }

    private static MediaType BrowseType(string? type) => type?.Trim().ToLowerInvariant() switch
    {
        null or "" => throw ViewerProblem.BadRequest("invalid_query", "Provide 'type' (movie or series)."),
        "movie" => MediaType.Movie,
        "series" or "tv" => MediaType.Tv,
        _ => throw ViewerProblem.BadRequest("invalid_query", "'type' must be movie or series."),
    };

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
