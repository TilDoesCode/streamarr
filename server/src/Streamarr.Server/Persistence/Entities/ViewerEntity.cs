namespace Streamarr.Server.Persistence.Entities;

/// <summary>A viewer (watch) account; fully separate from the admin <see cref="UserEntity"/> table.</summary>
public sealed class ViewerEntity
{
    public required string Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string NormalizedUsername { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string? AvatarKey { get; set; }
    public string? Email { get; set; }
    public string? NormalizedEmail { get; set; }
    public DateTimeOffset? EmailVerifiedAt { get; set; }
    public string? PendingEmail { get; set; }
    public string PasswordHash { get; set; } = string.Empty;
    public string PasswordSalt { get; set; } = string.Empty;
    public bool MustChangePassword { get; set; }
    public DateTimeOffset? PasswordChangedAt { get; set; }
    public bool IsDisabled { get; set; }
    public int? MaxAge { get; set; }
    public bool BlockUnrated { get; set; }
    public bool AllowTranscoding { get; set; } = true;
    public int? MaxConcurrentStreams { get; set; }
    public string? TotpSecretEncrypted { get; set; }
    public string? PendingTotpSecretEncrypted { get; set; }
    public DateTimeOffset? TotpEnabledAt { get; set; }
    public long? TotpLastUsedStep { get; set; }
    public int FailedLoginCount { get; set; }
    public DateTimeOffset? LockoutEndsAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? LastLoginAt { get; set; }
}
