namespace Streamarr.Server.Persistence.Entities;

/// <summary>Singleton row with the viewer-module settings JSON; the SMTP password is kept apart as ciphertext.</summary>
public sealed class ViewerConfigEntity
{
    public int Id { get; set; } = 1;
    public string SettingsJson { get; set; } = "{}";
    public string? SmtpPasswordEncrypted { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
