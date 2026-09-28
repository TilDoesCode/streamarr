using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Access;

public sealed record ContentAccessDecision(
    string WorkId,
    bool Allowed,
    string Reason,
    string? Rating,
    int? MinimumAge,
    int? ViewerMaxAge);

/// <summary>Age gate for viewers: compares the TMDB certification of a work with the viewer's age limit.</summary>
public sealed class ViewerContentPolicy(ITmdbClient tmdb, ILogger<ViewerContentPolicy> logger)
{
    public async Task<ContentAccessDecision> EvaluateAsync(ViewerEntity viewer, WorkKey work, CancellationToken ct)
    {
        var (rating, lookupFailed) = await RatingAsync(work, ct);
        var minimumAge = ContentRatings.MinimumAge(rating);
        return Decide(viewer, work.WorkId, rating, minimumAge, lookupFailed);
    }

    public static ContentAccessDecision Decide(ViewerEntity viewer, string workId, string? rating, int? minimumAge, bool lookupFailed)
    {
        string reason;
        bool allowed;
        if (viewer.MaxAge is not { } limit)
            (allowed, reason) = (true, "unrestricted");
        else if (lookupFailed)
            (allowed, reason) = (false, "rating_unavailable");
        else if (minimumAge is null)
            (allowed, reason) = viewer.BlockUnrated ? (false, "unrated_blocked") : (true, "unrated_allowed");
        else
            (allowed, reason) = minimumAge <= limit ? (true, "within_age_limit") : (false, "above_age_limit");
        return new ContentAccessDecision(workId, allowed, reason, rating, minimumAge, viewer.MaxAge);
    }

    private async Task<(string? Rating, bool Failed)> RatingAsync(WorkKey work, CancellationToken ct)
    {
        if (work.TmdbId is not { } id)
            return (null, false);
        try
        {
            var match = work.Kind == WorkKind.Movie
                ? await tmdb.GetMovieAsync(id, ct)
                : await tmdb.GetTvAsync(id, ct);
            return match is null ? (null, true) : (match.OfficialRating, false);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Rating lookup for {WorkId} failed", work.WorkId);
            return (null, true);
        }
    }
}
