namespace Streamarr.Server.Persistence.Entities;

/// <summary>Palette extracted from one artwork image; both colours null when the image could not be used.</summary>
public sealed class ArtworkPaletteEntity
{
    public string ImageUrl { get; set; } = string.Empty;
    public string? Tint { get; set; }
    public string? Tint2 { get; set; }
    public DateTimeOffset ComputedAt { get; set; }

    /// <summary><see cref="Viewers.Artwork.PaletteExtractor.Version"/> that produced the row; older rows are recomputed.</summary>
    public int Version { get; set; }
}
