using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Profiles;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Quality profile CRUD (BRIEF §6.2 / §7.3). The built-in default profile is always
/// listed and cannot be edited or deleted; user profiles are stored as JSON. No secrets.
/// Admin session required (BRIEF §6.4).
/// </summary>
[ApiController]
[Authorize(Policy = AuthRoles.AdminPolicy)]
[Route("api/v1/config/profiles")]
public class ProfilesController(ProfileConfigService profiles) : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<QualityProfile>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<QualityProfile>> List() => Ok(profiles.List());

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(QualityProfile), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<QualityProfile> Get(string id)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_profile_id", "The profile id is invalid."));

        var profile = profiles.FindById(id);
        return profile is null
            ? NotFound(ErrorResponse.Of("not_found", $"No profile with id '{id}'."))
            : Ok(profile);
    }

    [HttpPost]
    [ProducesResponseType(typeof(QualityProfile), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<QualityProfile>> Create([FromBody] QualityProfile profile, CancellationToken ct)
    {
        if (profile is null)
            return BadRequest(ErrorResponse.Of("invalid_profile", "A profile body is required."));
        if (!string.IsNullOrWhiteSpace(profile.Id))
            return BadRequest(ErrorResponse.Of("invalid_profile", "'id' is server-generated and must be omitted."));
        if (ValidateProfile(profile) is { } error)
            return BadRequest(error);

        var created = await profiles.CreateAsync(profile, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpPut("{id}")]
    [ProducesResponseType(typeof(QualityProfile), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<QualityProfile>> Update(string id, [FromBody] QualityProfile profile, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_profile_id", "The profile id is invalid."));
        if (id == DefaultProfiles.Standard.Id)
            return BadRequest(ErrorResponse.Of("read_only", "The built-in default profile cannot be edited."));
        if (ValidateProfile(profile) is { } error)
            return BadRequest(error);

        var updated = await profiles.UpdateAsync(id, profile, ct);
        return updated is null
            ? NotFound(ErrorResponse.Of("not_found", $"No profile with id '{id}'."))
            : Ok(updated);
    }

    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        if (InvalidId(id))
            return BadRequest(ErrorResponse.Of("invalid_profile_id", "The profile id is invalid."));
        if (id == DefaultProfiles.Standard.Id)
            return BadRequest(ErrorResponse.Of("read_only", "The built-in default profile cannot be deleted."));

        return await profiles.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No profile with id '{id}'."));
    }

    internal static ErrorResponse? ValidateProfile(QualityProfile? profile)
    {
        if (profile is null || string.IsNullOrWhiteSpace(profile.Name))
            return ErrorResponse.Of("invalid_profile", "A non-empty 'name' is required.");
        if (profile.Name.Length > 128 || profile.Id is null || profile.Id.Length > 128 ||
            ContainsControl(profile.Name) || ContainsControl(profile.Id))
            return ErrorResponse.Of("invalid_profile", "Profile id/name values are too long or contain control characters.");

        IReadOnlyList<string>?[] lists =
        {
            profile.PreferredResolutions,
            profile.PreferredSources,
            profile.PreferredCodecs,
            profile.PreferredLanguages,
            profile.GroupAllowList,
            profile.GroupDenyList,
        };
        if (lists.Any(list => list is null) || lists.Any(list => list!.Count > 100 || list.Any(v =>
                string.IsNullOrWhiteSpace(v) || v.Length > 128 || ContainsControl(v))))
            return ErrorResponse.Of("invalid_profile", "Preference lists may contain at most 100 bounded, non-empty values.");
        if (lists.Any(list => list!.Distinct(StringComparer.OrdinalIgnoreCase).Count() != list!.Count))
            return ErrorResponse.Of("invalid_profile", "Preference lists cannot contain duplicate values.");
        if (profile.GroupAllowList.Intersect(profile.GroupDenyList, StringComparer.OrdinalIgnoreCase).Any())
            return ErrorResponse.Of("invalid_profile", "A release group cannot appear in both allow and deny lists.");

        var weights = new[]
        {
            profile.ResolutionWeight, profile.SourceWeight, profile.CodecWeight,
            profile.LanguageWeight, profile.AudioWeight, profile.SizeWeight,
            profile.ProperRepackBonus, profile.RecencyBonus, profile.GrabsBonus,
            profile.GroupAllowBonus, profile.GroupDenyPenalty,
        };
        if (weights.Any(w => w is < 0 or > 1_000_000))
            return ErrorResponse.Of("invalid_profile", "Profile weights and bonuses must be between 0 and 1000000.");

        const long maxBand = 16L * 1024 * 1024 * 1024 * 1024;
        if (!ValidBand(profile.MinBytesPerMinute, profile.MaxBytesPerMinute) ||
            profile.SizeBands is null || profile.SizeBands.Count > 32)
            return ErrorResponse.Of("invalid_profile", "The global size band or size-band count is invalid.");
        foreach (var (key, band) in profile.SizeBands)
        {
            if (string.IsNullOrWhiteSpace(key) || key.Length > 32 || ContainsControl(key) || band is null ||
                !ValidBand(band.MinBytesPerMinute, band.MaxBytesPerMinute))
                return ErrorResponse.Of("invalid_profile", "One or more resolution size bands are invalid.");
        }

        return null;

        static bool ValidBand(long min, long max) => min >= 0 && min <= max && max <= maxBand;
        static bool ContainsControl(string value) => value.Any(char.IsControl);
    }

    private static bool InvalidId(string? id)
        => string.IsNullOrWhiteSpace(id) || id.Length > 128 || id.Any(char.IsControl);
}
