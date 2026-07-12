using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Profiles;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Controllers;

/// <summary>
/// Quality profile CRUD (BRIEF §6.2 / §7.3). The built-in default profile is always
/// listed and cannot be edited or deleted; user profiles are stored as JSON. No secrets.
/// </summary>
[ApiController]
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
        if (Validate(profile) is { } error)
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
        if (id == DefaultProfiles.Standard.Id)
            return BadRequest(ErrorResponse.Of("read_only", "The built-in default profile cannot be edited."));
        if (Validate(profile) is { } error)
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
        if (id == DefaultProfiles.Standard.Id)
            return BadRequest(ErrorResponse.Of("read_only", "The built-in default profile cannot be deleted."));

        return await profiles.DeleteAsync(id, ct)
            ? NoContent()
            : NotFound(ErrorResponse.Of("not_found", $"No profile with id '{id}'."));
    }

    private static ErrorResponse? Validate(QualityProfile? profile)
        => profile is null || string.IsNullOrWhiteSpace(profile.Name)
            ? ErrorResponse.Of("invalid_profile", "A non-empty 'name' is required.")
            : null;
}
