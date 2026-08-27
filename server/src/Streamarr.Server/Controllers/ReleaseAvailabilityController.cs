using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

[ApiController]
[Route("api/v1/releases/local-availability")]
public sealed class ReleaseAvailabilityController(
    SessionManager sessions,
    IReleaseStore releaseStore,
    GeneralConfigService generalConfig) : ControllerBase
{
    private const int MaximumWorkIds = 200;
    private const int MaximumReleasesPerWork = 20;

    [HttpPost]
    [ProducesResponseType(typeof(LocalReleaseAvailabilityResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<LocalReleaseAvailabilityResponse>> List(
        [FromBody] LocalReleaseAvailabilityRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null
            || request.WorkIds is null
            || request.WorkIds.Count is < 1 or > MaximumWorkIds
            || request.WorkIds.Any(workId => !Valid(workId, 256))
            || !Valid(request.Client, 64)
            || !Valid(request.RequestedById, 256))
        {
            return BadRequest(ErrorResponse.Of(
                "invalid_local_release_availability_request",
                $"Provide 1 to {MaximumWorkIds} valid work ids, a client, and a requester id."));
        }

        var workIds = request.WorkIds.ToHashSet(StringComparer.Ordinal);
        var localReleases = sessions.ListLocalReleaseAvailability(
                workIds,
                request.Client,
                request.RequestedById)
            .GroupBy(release => release.WorkId, StringComparer.Ordinal)
            .SelectMany(group => group
                .OrderByDescending(release => release.State == "ready")
                .ThenBy(release => release.ReleaseId, StringComparer.Ordinal)
                .Take(MaximumReleasesPerWork))
            .Select(release => new
            {
                Availability = release,
                Registration = releaseStore.Get(release.ReleaseId, release.WorkId),
            })
            .ToArray();
        var addReleaseScoreToName = (await generalConfig.GetAsync(cancellationToken))
            .AddReleaseScoreToName;
        var releases = localReleases
            .Select(local => new LocalReleaseAvailabilityEntry
            {
                WorkId = local.Availability.WorkId,
                ReleaseId = local.Availability.ReleaseId,
                State = local.Availability.State,
                Release = local.Registration is null
                    ? null
                    : SearchController.ToReleaseDto(
                        local.Registration.Release,
                        addReleaseScoreToName),
            })
            .ToArray();
        return Ok(new LocalReleaseAvailabilityResponse { Releases = releases });
    }

    private static bool Valid(string? value, int maximumLength)
        => !string.IsNullOrWhiteSpace(value)
           && value.Length <= maximumLength
           && string.Equals(value, value.Trim(), StringComparison.Ordinal)
           && !value.Any(char.IsControl);
}
