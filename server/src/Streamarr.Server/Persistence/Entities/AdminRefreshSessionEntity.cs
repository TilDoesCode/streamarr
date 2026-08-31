namespace Streamarr.Server.Persistence.Entities;

/// <summary>A hashed, rotating browser refresh token for a management user.</summary>
public sealed class AdminRefreshSessionEntity
{
    public string TokenHash { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? ReplacedByTokenHash { get; set; }
    public string? ReplacementTokenEncrypted { get; set; }
}
