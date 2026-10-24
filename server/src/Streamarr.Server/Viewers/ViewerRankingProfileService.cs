using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers;

/// <summary>The viewer's own ranking profile, stored per account so TV, phone and web rank alike.</summary>
public sealed class ViewerRankingProfileService(
    ProfileConfigService profiles,
    RankingProfileResolver resolver,
    IDbContextFactory<StreamarrDbContext> dbFactory,
    TimeProvider time)
{
    public ViewerRankingProfileResponse Describe(ViewerEntity viewer)
    {
        var movie = resolver.ServerDefault(MediaType.Movie);
        var series = resolver.ServerDefault(MediaType.Tv);
        return new ViewerRankingProfileResponse
        {
            ProfileId = viewer.RankingProfileId is { } id && profiles.FindById(id) is not null ? id : null,
            CanChoose = profiles.Defaults.ViewersMayChoose,
            Movie = RankingProfileTraits.Ref(resolver.ForViewer(viewer, MediaType.Movie)),
            Series = RankingProfileTraits.Ref(resolver.ForViewer(viewer, MediaType.Tv)),
            ServerDefault = new RankingProfileDefaultsDto { Movie = RankingProfileTraits.Ref(movie), Series = RankingProfileTraits.Ref(series) },
            Profiles = profiles.List().Select(p => new ViewerRankingProfileDto
            {
                Id = p.Id,
                Name = p.Name,
                Description = string.IsNullOrWhiteSpace(p.Description) ? null : p.Description.Trim(),
                MediaTypes = RankingProfileTraits.MediaTypes(p),
                Traits = RankingProfileTraits.From(p),
                ServerDefault = p.Id == movie.Profile.Id || p.Id == series.Profile.Id,
            }).ToList(),
        };
    }

    /// <summary>Stores the viewer's choice (null = server default); <c>403 profile_choice_disabled</c> when viewers may not choose, <c>400 unknown_profile</c> for an unknown id.</summary>
    public async Task<ViewerEntity> SetAsync(string viewerId, string? profileId, CancellationToken ct)
    {
        if (!profiles.Defaults.ViewersMayChoose)
            throw ViewerProblem.Forbidden("profile_choice_disabled", "The server operator does not let viewers choose a ranking profile.");
        profileId = string.IsNullOrWhiteSpace(profileId) ? null : profileId.Trim();
        if (profileId is not null && (profileId.Length > 128 || profiles.FindById(profileId) is null))
            throw ViewerProblem.BadRequest("unknown_profile", "No ranking profile with this id exists.");

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var viewer = await db.Viewers.FirstOrDefaultAsync(v => v.Id == viewerId, ct)
                     ?? throw ViewerProblem.NotFound("viewer_not_found", "The viewer account was not found.");
        viewer.RankingProfileId = profileId;
        viewer.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        return viewer;
    }
}
