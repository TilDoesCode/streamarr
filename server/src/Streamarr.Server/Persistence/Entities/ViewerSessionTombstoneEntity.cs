namespace Streamarr.Server.Persistence.Entities;

/// <summary>A refresh-token hash of a deleted viewer session, kept for 30 days so an old token maps to why its session ended.</summary>
public sealed class ViewerSessionTombstoneEntity
{
    public required string RefreshTokenHash { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public string ViewerId { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public DateTimeOffset EndedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}
