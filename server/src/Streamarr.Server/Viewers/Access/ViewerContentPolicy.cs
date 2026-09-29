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
    private readonly ITmdbClient _tmdb = tmdb.Strict;

    /// <summary>The age-gate decision; a restricted viewer gets <c>503 catalog_unavailable</c> while TMDB is down and the rating is not cached.</summary>
    public async Task<ContentAccessDecision> EvaluateAsync(ViewerEntity viewer, WorkKey work, CancellationToken ct)
    {
        var (rating, lookupFailed, transient) = await RatingAsync(work, ct);
        if (transient && viewer.MaxAge is not null)
            throw ViewerProblem.CatalogUnavailable();
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

    /// <summary><c>403 age_restricted</c> with the reason, rating and ages as <c>params</c>.</summary>
    public static ViewerProblem AgeRestricted(ContentAccessDecision decision)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal) { ["reason"] = decision.Reason };
        if (decision.Rating is { } rating)
            parameters["rating"] = rating;
        if (decision.MinimumAge is { } minimum)
            parameters["minimumAge"] = minimum.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (decision.ViewerMaxAge is { } max)
            parameters["viewerMaxAge"] = max.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new ViewerProblem(StatusCodes.Status403Forbidden, "age_restricted",
            $"This title is not available for this profile ({decision.Reason}).", parameters);
    }

    private async Task<(string? Rating, bool Failed, bool Transient)> RatingAsync(WorkKey work, CancellationToken ct)
    {
        if (work.TmdbId is not { } id)
            return (null, false, false);
        try
        {
            var match = work.Kind == WorkKind.Movie
                ? await _tmdb.GetMovieAsync(id, ct)
                : await _tmdb.GetTvAsync(id, ct);
            return match is null ? (null, true, false) : (match.OfficialRating, false, false);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Rating lookup for {WorkId} failed", work.WorkId);
            return (null, true, e is TmdbTransientException);
        }
    }
}
