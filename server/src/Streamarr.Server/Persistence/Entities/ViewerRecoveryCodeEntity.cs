namespace Streamarr.Server.Persistence.Entities;

/// <summary>A single-use two-factor recovery code, stored as a SHA-256 hash.</summary>
public sealed class ViewerRecoveryCodeEntity
{
    public long Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;
    public string CodeHash { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
}
