using Jellyfin.Data.Enums;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Search;
using Streamarr.Plugin.Api;

namespace Streamarr.Plugin.Search;

/// <summary>
/// Pure translation + merge helpers for the search-interception path (BRIEF §8.2). These are
/// deliberately host-free (they touch only Jellyfin model DTOs, never a running Jellyfin) so the
/// merge/dedup and hint-shaping logic is unit-testable without a Jellyfin server. All the
/// version-sensitive HTTP-pipeline coupling lives in <see cref="StreamarrSearchActionFilter"/>;
/// this file is safe, ordinary data-shaping and contains no domain logic (BRIEF §11).
/// </summary>
public static class SearchInjection
{
    /// <summary>
    /// Appends injected ephemeral works to the native result set, de-duplicated by item id and
    /// preserving native ordering first. Returns the native list unchanged when nothing is
    /// injected so a no-op interception never reallocates.
    /// </summary>
    public static IReadOnlyList<BaseItemDto> MergeItems(
        IReadOnlyList<BaseItemDto> native,
        IReadOnlyList<BaseItemDto> injected)
    {
        if (injected.Count == 0)
            return native;

        var seen = new HashSet<Guid>(native.Select(i => i.Id));
        var merged = new List<BaseItemDto>(native);
        foreach (var dto in injected)
        {
            if (dto.Id != Guid.Empty && seen.Add(dto.Id))
                merged.Add(dto);
        }

        return merged;
    }

    /// <summary>Same append-and-dedup contract as <see cref="MergeItems"/>, for search hints.</summary>
    public static IReadOnlyList<SearchHint> MergeHints(
        IReadOnlyList<SearchHint> native,
        IReadOnlyList<SearchHint> injected)
    {
        if (injected.Count == 0)
            return native;

        var seen = new HashSet<Guid>(native.Select(h => h.Id));
        var merged = new List<SearchHint>(native);
        foreach (var hint in injected)
        {
            if (hint.Id != Guid.Empty && seen.Add(hint.Id))
                merged.Add(hint);
        }

        return merged;
    }

    /// <summary>Builds the search hint for a materialized ephemeral work.</summary>
    public static SearchHint BuildHint(Guid itemId, WorkDto work) => new()
    {
        Id = itemId,
        Name = work.Title,
        MatchedTerm = work.Title,
        ProductionYear = work.Year,
        Type = KindFor(work),
        MediaType = MediaType.Video,
        IsFolder = false,
        RunTimeTicks = RuntimeTicks(work.RuntimeMinutes),
        IndexNumber = work.Episode,
        ParentIndexNumber = work.Season,
    };

    public static bool IsEpisode(WorkDto work)
        => string.Equals(work.MediaType, "tv", StringComparison.OrdinalIgnoreCase)
           || string.Equals(work.MediaType, "episode", StringComparison.OrdinalIgnoreCase);

    public static BaseItemKind KindFor(WorkDto work)
        => IsEpisode(work) ? BaseItemKind.Episode : BaseItemKind.Movie;

    public static long? RuntimeTicks(int? minutes)
        => minutes is > 0 ? TimeSpan.FromMinutes(minutes.Value).Ticks : null;
}
