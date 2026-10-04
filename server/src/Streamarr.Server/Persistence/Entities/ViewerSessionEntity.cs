namespace Streamarr.Server.Persistence.Entities;

/// <summary>One signed-in viewer device: hashed opaque access + rotating refresh token.</summary>
public sealed class ViewerSessionEntity
{
    public required string Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;
    public string AccessTokenHash { get; set; } = string.Empty;
    public DateTimeOffset AccessExpiresAt { get; set; }
    public string RefreshTokenHash { get; set; } = string.Empty;
    public string? PreviousRefreshTokenHash { get; set; }
    public DateTimeOffset? RotatedAt { get; set; }
    public string? RotatedTokensEncrypted { get; set; }
    /// <summary>Expiry the previous refresh token had before the rotation; a replay is only offered within it.</summary>
    public DateTimeOffset? PreviousRefreshExpiresAt { get; set; }
    /// <summary>First use of the rotated pair (its access token authenticated or its refresh token presented); null = unused.</summary>
    public DateTimeOffset? RotationConfirmedAt { get; set; }
    /// <summary>Space-separated hashes of refresh tokens older than the previous one; presenting one ends the session.</summary>
    public string? RetiredRefreshTokenHashes { get; set; }
    public DateTimeOffset RefreshExpiresAt { get; set; }
    public string? DeviceName { get; set; }
    public string ClientName { get; set; } = string.Empty;
    public string AuthMethod { get; set; } = string.Empty;
    public bool CookieMode { get; set; }
    public string? IpAddress { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? RevokedReason { get; set; }
}
