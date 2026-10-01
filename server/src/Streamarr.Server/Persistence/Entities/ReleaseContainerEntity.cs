namespace Streamarr.Server.Persistence.Entities;

/// <summary>The real container family of a release the server has opened; least recently used rows are evicted.</summary>
public sealed class ReleaseContainerEntity
{
    public string ReleaseId { get; set; } = string.Empty;
    public string Family { get; set; } = string.Empty;
    public DateTimeOffset LastUsedAt { get; set; }
}
