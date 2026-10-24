using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.MyList;

/// <summary>Keeps the list in step with playback: a started series is added automatically (unless the viewer removed it) and playing the new episode clears the new flag.</summary>
public static class MyListTracking
{
    public const string Manual = "manual";
    public const string Auto = "auto";

    /// <summary>Applies to the tracked context; the caller saves.</summary>
    public static async Task TrackAsync(StreamarrDbContext db, string viewerId, IReadOnlyCollection<WorkKey> episodes, DateTimeOffset now, CancellationToken ct)
    {
        var played = episodes.Where(e => e is { Kind: WorkKind.Episode, TmdbId: not null }).ToList();
        if (played.Count == 0)
            return;
        var seriesIds = played.Select(e => e.SeriesWorkId!).Distinct(StringComparer.Ordinal).ToList();
        var episodeIds = played.Select(e => e.WorkId).ToList();
        var entries = await db.ViewerListEntries
            .Where(e => e.ViewerId == viewerId && e.SeriesWorkId != null && seriesIds.Contains(e.SeriesWorkId))
            .ToListAsync(ct);

        foreach (var entry in entries.Where(e => e.NewEpisodeWorkId is not null && episodeIds.Contains(e.NewEpisodeWorkId)))
        {
            entry.NewAvailableSince = null;
            entry.SeenAt = now;
            entry.UpdatedAt = now;
        }

        foreach (var episode in played.DistinctBy(e => e.SeriesWorkId))
        {
            if (entries.Any(e => e.WorkId == episode.SeriesWorkId))
                continue;
            var entry = new ViewerListEntryEntity
            {
                ViewerId = viewerId,
                WorkId = episode.SeriesWorkId!,
                Kind = "series",
                TmdbId = episode.TmdbId!.Value,
                SeriesWorkId = episode.SeriesWorkId,
                Source = Auto,
                AddedAt = now,
                UpdatedAt = now,
            };
            db.ViewerListEntries.Add(entry);
            entries.Add(entry);
        }
    }
}
