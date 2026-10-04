namespace Streamarr.Server.Persistence.Entities;

/// <summary>Technical summary of the best known version of a movie, episode or season, kept from the last version lookup.</summary>
public sealed class CatalogSpecSummaryEntity
{
    public string WorkId { get; set; } = string.Empty;
    public string? Resolution { get; set; }
    public string? Hdr { get; set; }
    public string? VideoCodec { get; set; }
    public string? Audio { get; set; }
    /// <summary>At least one version that is not known dead; null = not recorded yet.</summary>
    public bool? Available { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
