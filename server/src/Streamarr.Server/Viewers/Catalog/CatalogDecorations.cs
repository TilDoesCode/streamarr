using Streamarr.Core.Tmdb;
using Streamarr.Server.Viewers.Artwork;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>Adds the title, palette, spec summary and availability to watch lists (continue watching, next up); episodes inherit the series title and palette.</summary>
public sealed class CatalogDecorations(ITmdbClient tmdb, ArtworkPaletteService palettes, CatalogSpecStore specs, SpecWarmupService warmup, ILogger<CatalogDecorations> logger)
{
    public NextUpItemResponse NextUp(NextUpItem item)
    {
        var palette = palettes.For(item.SeriesBackdropUrl, item.SeriesPosterUrl);
        var spec = specs.Get(item.WorkId);
        var available = specs.Available(item.WorkId);
        if (spec is null || available is null)
            warmup.Request([item.WorkId]);
        return ViewerMappings.NextUp(item) with
        {
            Tint = palette?.Tint, Tint2 = palette?.Tint2, Highlight = palette?.Highlight, Spec = spec, Available = available ?? true,
        };
    }

    public async Task<IReadOnlyList<WatchStateResponse>> ResumeAsync(IReadOnlyList<WatchStateResponse> items, CancellationToken ct)
    {
        var titles = new Dictionary<string, Task<TmdbMatch?>>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (TitleKey(item) is { } key && !titles.ContainsKey(key.Id))
                titles[key.Id] = TitleAsync(key.Movie, key.TmdbId, ct);
        }
        await Task.WhenAll(titles.Values);
        var decorated = items.Select(item =>
        {
            var title = TitleKey(item) is { } key ? titles[key.Id].Result : null;
            var palette = title is null ? null : palettes.For(title.BackdropUrl, title.PosterUrl);
            return item with
            {
                Title = string.IsNullOrWhiteSpace(title?.Title) ? item.Title : title.Title,
                Tint = palette?.Tint, Tint2 = palette?.Tint2, Highlight = palette?.Highlight, Spec = specs.Get(item.WorkId),
                Available = specs.Available(item.WorkId),
            };
        }).ToList();
        warmup.Request(decorated.Where(i => i.Spec is null || i.Available is null).Select(i => i.WorkId));
        decorated = decorated.Select(i => i with { Available = i.Available ?? true }).ToList();
        return decorated;
    }

    private static (string Id, bool Movie, int TmdbId)? TitleKey(WatchStateResponse item)
        => WorkKey.TryParse(item.WorkId) switch
        {
            { Kind: WorkKind.Movie, TmdbId: { } id } => ($"movie:{id}", true, id),
            { Kind: WorkKind.Episode, TmdbId: { } id } => ($"tv:{id}", false, id),
            _ => null,
        };

    private async Task<TmdbMatch?> TitleAsync(bool movie, int tmdbId, CancellationToken ct)
    {
        try
        {
            return movie ? await tmdb.GetMovieAsync(tmdbId, ct) : (await tmdb.GetTvSeriesCatalogAsync(tmdbId, ct))?.Series;
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogDebug(e, "Artwork lookup for {TmdbId} failed", tmdbId);
            return null;
        }
    }
}
