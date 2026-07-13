namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// A management user (BRIEF §6.4). The model is deliberately multi-user ready — a
/// <see cref="Role"/> column and a full users table rather than a hardcoded admin — so it
/// can grow into real multi-user later without a schema break. Passwords are stored only
/// as a PBKDF2 hash + per-user salt; the plaintext is never persisted.
/// </summary>
public sealed class UserEntity
{
    public required string Id { get; set; }

    /// <summary>Unique login name (case-insensitive match is enforced in the service).</summary>
    public string Username { get; set; } = string.Empty;

    /// <summary>Base64 PBKDF2 hash of the password.</summary>
    public string PasswordHash { get; set; } = string.Empty;

    /// <summary>Base64 per-user salt.</summary>
    public string PasswordSalt { get; set; } = string.Empty;

    /// <summary>Authorization role ("admin"). Extensible to further roles later.</summary>
    public string Role { get; set; } = "admin";

    public DateTimeOffset CreatedAt { get; set; }
}
