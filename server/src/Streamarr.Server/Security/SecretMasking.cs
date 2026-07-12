namespace Streamarr.Server.Security;

/// <summary>
/// Mask-on-read / write-only secret conventions for the config API (BRIEF §6.3):
/// GETs never return plaintext secrets; PUT/POST omit-to-keep — a null, empty, or
/// masked incoming value leaves the stored secret unchanged.
/// </summary>
public static class SecretMasking
{
    /// <summary>Placeholder returned in GETs when a secret is set.</summary>
    public const string Mask = "••••••••";

    /// <summary>Masked representation of a stored secret: the mask if set, else null.</summary>
    public static string? Masked(string? storedCiphertext)
        => string.IsNullOrEmpty(storedCiphertext) ? null : Mask;

    /// <summary>True when an incoming secret should be treated as "leave unchanged".</summary>
    public static bool IsOmitted(string? incoming)
        => string.IsNullOrEmpty(incoming) || incoming == Mask;
}
