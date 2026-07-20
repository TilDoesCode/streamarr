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
public class ProfilesController(ProfileConfigService profiles, ProfileImportService importer) : ControllerBase
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

    [HttpPost("import/preview")]
    [ProducesResponseType(typeof(ProfileImportPreviewResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<ProfileImportPreviewResponse>> PreviewImport(
        [FromBody] ProfileImportPreviewRequest request,
        CancellationToken ct)
    {
        try
        {
            return Ok(await importer.PreviewAsync(request, ct));
        }
        catch (ProfileImportException exception)
        {
            var error = ErrorResponse.Of("profile_import_failed", exception.Message);
            return exception.RequestError ? BadRequest(error) : StatusCode(StatusCodes.Status502BadGateway, error);
        }
    }

    [HttpPost("import")]
    [ProducesResponseType(typeof(IReadOnlyList<QualityProfile>), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status502BadGateway)]
    public async Task<ActionResult<IReadOnlyList<QualityProfile>>> Import(
        [FromBody] ProfileImportRequest request,
        CancellationToken ct)
    {
        try
        {
            var drafts = await importer.BuildImportsAsync(request, ct);
            foreach (var draft in drafts)
            {
                if (ValidateProfile(draft) is { } validation)
                    return BadRequest(validation);
            }

            var created = await profiles.CreateManyAsync(drafts, ct);
            return StatusCode(StatusCodes.Status201Created, created);
        }
        catch (ProfileImportException exception)
        {
            var error = ErrorResponse.Of("profile_import_failed", exception.Message);
            return exception.RequestError ? BadRequest(error) : StatusCode(StatusCodes.Status502BadGateway, error);
        }
    }

    internal static ErrorResponse? ValidateProfile(QualityProfile? profile)
    {
        if (profile is null || string.IsNullOrWhiteSpace(profile.Name))
            return ErrorResponse.Of("invalid_profile", "A non-empty 'name' is required.");
        if (profile.AppliesTo is null || profile.AppliesTo is not ("both" or "movies" or "shows"))
            return ErrorResponse.Of("invalid_profile", "'appliesTo' must be 'movies', 'shows', or 'both'.");
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
        if (profile.MinimumCustomFormatScore is < -10_000_000 or > 10_000_000 ||
            profile.CustomFormats is null || profile.CustomFormats.Count > 256)
            return ErrorResponse.Of("invalid_profile", "The custom-format score threshold or format count is invalid.");
        foreach (var format in profile.CustomFormats)
        {
            if (format is null || string.IsNullOrWhiteSpace(format.Name) || format.Name.Length > 256 ||
                ContainsControl(format.Name) || format.Score is < -10_000_000 or > 10_000_000 ||
                format.Conditions is null || format.Conditions.Count > 64)
                return ErrorResponse.Of("invalid_profile", "One or more custom formats are invalid.");
            foreach (var condition in format.Conditions)
            {
                if (condition is null || string.IsNullOrWhiteSpace(condition.Implementation) ||
                    condition.Name is null || condition.Implementation.Length > 128 || condition.Name.Length > 256 ||
                    condition.Value?.Length > 4096 || ContainsControl(condition.Implementation) ||
                    ContainsControl(condition.Name) || condition.Value is { } value && ContainsControl(value) ||
                    condition.Min is < 0 || condition.Max is < 0 ||
                    condition.Min is { } min && condition.Max is { } max && min > max)
                    return ErrorResponse.Of("invalid_profile", "One or more custom-format conditions are invalid.");
            }
        }

        if (profile.ImportedFrom is { } importedFrom && importedFrom is not ("sonarr" or "radarr"))
            return ErrorResponse.Of("invalid_profile", "'importedFrom' must be Sonarr or Radarr.");

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
