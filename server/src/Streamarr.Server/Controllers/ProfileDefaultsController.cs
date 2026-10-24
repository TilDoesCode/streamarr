using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// The server-wide ranking profile defaults: the profile everything without its own choice ranks with (Jellyfin, admin
/// search without <c>profileId</c>, viewers that follow the server), optional overrides for movies and series, and whether
/// viewers may choose their own profile in the app. Admin session required.
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/profile-defaults")]
public class ProfileDefaultsController(ProfileConfigService profiles, RankingProfileResolver resolver) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(ProfileDefaultsResponse), StatusCodes.Status200OK)]
    public ActionResult<ProfileDefaultsResponse> Get() => Ok(Describe());

    /// <summary>Replace the defaults; <c>400 unknown_profile</c> for an unknown id, <c>400 profile_media_type_mismatch</c> when an override does not apply to its media type.</summary>
    [HttpPut]
    [ProducesResponseType(typeof(ProfileDefaultsResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<ProfileDefaultsResponse>> Update([FromBody] ProfileDefaultsRequest request, CancellationToken ct)
    {
        if (request is null)
            return BadRequest(ErrorResponse.Of("invalid_request", "A body is required."));
        string?[] ids = [request.DefaultProfileId, request.MovieProfileId, request.SeriesProfileId];
        if (ids.Any(id => id is { } value && (value.Length is 0 or > 128 || value.Any(char.IsControl))))
            return BadRequest(ErrorResponse.Of("invalid_profile_id", "A profile id is invalid."));

        var error = await profiles.UpdateDefaultsAsync(new ProfileDefaults(
            request.DefaultProfileId,
            request.MovieProfileId,
            request.SeriesProfileId,
            request.ViewersMayChoose ?? profiles.Defaults.ViewersMayChoose), ct);
        return error is { } failed ? BadRequest(ErrorResponse.Of(failed.Code, failed.Message)) : Ok(Describe());
    }

    private ProfileDefaultsResponse Describe()
    {
        var defaults = profiles.Defaults;
        return new ProfileDefaultsResponse
        {
            DefaultProfileId = defaults.DefaultProfileId is { } id && profiles.FindById(id) is not null ? id : DefaultProfiles.Standard.Id,
            MovieProfileId = defaults.MovieProfileId,
            SeriesProfileId = defaults.SeriesProfileId,
            ViewersMayChoose = defaults.ViewersMayChoose,
            Effective = new RankingProfileDefaultsDto
            {
                Movie = RankingProfileTraits.Ref(resolver.ServerDefault(MediaType.Movie)),
                Series = RankingProfileTraits.Ref(resolver.ServerDefault(MediaType.Tv)),
            },
        };
    }
}
