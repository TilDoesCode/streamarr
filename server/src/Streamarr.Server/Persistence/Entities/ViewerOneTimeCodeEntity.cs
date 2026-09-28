namespace Streamarr.Server.Persistence.Entities;

/// <summary>A salted-hash, attempt-limited emailed code (login, password reset, email verification).</summary>
public sealed class ViewerOneTimeCodeEntity
{
    public required string Id { get; set; }
    public string ViewerId { get; set; } = string.Empty;
    public string Purpose { get; set; } = string.Empty;
    public string CodeHash { get; set; } = string.Empty;
    public string Salt { get; set; } = string.Empty;
    public string? Target { get; set; }
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
}
