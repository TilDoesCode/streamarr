namespace Streamarr.Server.Persistence.Entities;

/// <summary>
/// Persisted quality preference profile (BRIEF §7.3). The full ranking profile —
/// weights, preferred lists, size bands — is serialized to <see cref="PayloadJson"/>;
/// only identity/name are promoted to columns for listing. No secrets here.
/// </summary>
public sealed class ProfileEntity
{
    public required string Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>JSON of the full <see cref="Core.Profiles.QualityProfile"/>.</summary>
    public string PayloadJson { get; set; } = string.Empty;
}
