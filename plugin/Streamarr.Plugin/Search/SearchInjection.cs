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
    /// The subset of Jellyfin search constraints that synthetic items can safely honor. A
    /// non-root or later-page query is never augmented: appending after Jellyfin has already
    /// paged its native results would repeat synthetic entries on every page.
    /// </summary>
    public sealed record Constraints(
        int StartIndex,
        int? Limit,
        Guid? ParentId,
        IReadOnlySet<BaseItemKind> IncludeItemTypes,
        IReadOnlySet<BaseItemKind> ExcludeItemTypes,
        IReadOnlySet<MediaType> MediaTypes,
        bool IncludeMedia,
        bool? IsMovie,
        bool? IsSeries,
        MediaType SeriesMediaType,
        bool IsValid = true)
    {
        public bool CanInjectAtRoot
            => IsValid && StartIndex == 0 && (!ParentId.HasValue || ParentId.Value == Guid.Empty);

        /// <summary>
        /// Translate an unambiguous Jellyfin item-kind constraint to Core's neutral media type.
        /// Retained for callers that explicitly request legacy episode works; global discovery
        /// now injects series folders instead of a flat episode sample.
        /// </summary>
        public string? CoreMediaType
        {
            get
            {
                if (IsMovie == true)
                    return "movie";
                if (IncludeItemTypes.Count == 1 && IncludeItemTypes.Contains(BaseItemKind.Movie))
                    return "movie";
                if (IncludeItemTypes.Count == 1 && IncludeItemTypes.Contains(BaseItemKind.Episode))
                    return "tv";
                return null;
            }
        }

        public int RemainingCapacity(int nativeCount, int defaultLimit)
        {
            if (!CanInjectAtRoot || !IncludeMedia)
                return 0;

            var effectiveLimit = Limit ?? defaultLimit;
            return effectiveLimit <= 0 ? 0 : Math.Max(0, effectiveLimit - nativeCount);
        }

        public bool Allows(WorkDto work)
            => AllowsKind(KindFor(work));

        public bool AllowsSeries(TvSeriesDto series)
            => series.TmdbId > 0
               && !string.IsNullOrWhiteSpace(series.WorkId)
               && !string.IsNullOrWhiteSpace(series.Title)
               && AllowsKind(BaseItemKind.Series);

        public bool AllowsMovieDiscovery => AllowsKind(BaseItemKind.Movie);

        public bool AllowsSeriesDiscovery => AllowsKind(BaseItemKind.Series);

        private bool AllowsKind(BaseItemKind kind)
        {
            if (!CanInjectAtRoot || !IncludeMedia)
                return false;

            if (IncludeItemTypes.Count > 0 && !IncludeItemTypes.Contains(kind))
                return false;
            if (ExcludeItemTypes.Contains(kind))
                return false;
            if (MediaTypes.Count > 0)
            {
                var mediaType = kind == BaseItemKind.Series ? SeriesMediaType : MediaType.Video;
                if (!MediaTypes.Contains(mediaType))
                    return false;
            }

            if (IsMovie is { } wantsMovie && (kind == BaseItemKind.Movie) != wantsMovie)
                return false;

            if (IsSeries is { } wantsSeries && (kind == BaseItemKind.Series) != wantsSeries)
                return false;

            return true;
        }
    }

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
    public static SearchHint BuildHint(
        Guid itemId,
        WorkDto work,
        string? primaryImageTag = null,
        string? backdropImageTag = null) => new()
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
            PrimaryImageTag = primaryImageTag,
            BackdropImageTag = backdropImageTag,
            BackdropImageItemId = backdropImageTag is null ? null : itemId.ToString("N"),
        };

    /// <summary>Builds a folder-style Jellyfin hint for a lazily populated TV series.</summary>
    public static SearchHint BuildSeriesHint(
        Guid itemId,
        TvSeriesDto series,
        string? primaryImageTag = null,
        string? backdropImageTag = null) => new()
        {
            Id = itemId,
            Name = series.Title,
            MatchedTerm = series.Title,
            ProductionYear = series.Year,
            Type = BaseItemKind.Series,
            MediaType = MediaType.Video,
            IsFolder = true,
            RunTimeTicks = RuntimeTicks(series.RuntimeMinutes),
            PrimaryImageTag = primaryImageTag,
            BackdropImageTag = backdropImageTag,
            BackdropImageItemId = backdropImageTag is null ? null : itemId.ToString("N"),
        };

    public static bool IsEpisode(WorkDto work)
        => string.Equals(work.MediaType, "tv", StringComparison.OrdinalIgnoreCase)
           || string.Equals(work.MediaType, "episode", StringComparison.OrdinalIgnoreCase);

    public static BaseItemKind KindFor(WorkDto work)
        => IsEpisode(work) ? BaseItemKind.Episode : BaseItemKind.Movie;

    public static long? RuntimeTicks(int? minutes)
        => minutes is > 0 ? TimeSpan.FromMinutes(minutes.Value).Ticks : null;
}
