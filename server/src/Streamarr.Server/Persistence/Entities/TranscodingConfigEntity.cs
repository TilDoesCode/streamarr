namespace Streamarr.Server.Persistence.Entities;

/// <summary>Singleton row holding the transcoding policy as a versionless JSON document.</summary>
public sealed class TranscodingConfigEntity
{
    public int Id { get; set; } = 1;
    public string SettingsJson { get; set; } = "{}";
    public DateTimeOffset UpdatedAt { get; set; }
}
