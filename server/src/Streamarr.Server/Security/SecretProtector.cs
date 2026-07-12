using Microsoft.AspNetCore.DataProtection;

namespace Streamarr.Server.Security;

/// <summary>
/// Encrypts/decrypts config secrets at rest (BRIEF §6.3: provider passwords, indexer
/// API keys, TMDB key). Backed by ASP.NET Data Protection with a persisted key ring so
/// ciphertext survives restarts.
/// </summary>
public interface ISecretProtector
{
    /// <summary>Encrypt plaintext to storable ciphertext; null/empty maps to null.</summary>
    string? Protect(string? plaintext);

    /// <summary>Decrypt ciphertext back to plaintext; null/empty maps to empty string.</summary>
    string Unprotect(string? ciphertext);
}

public sealed class SecretProtector(IDataProtectionProvider provider) : ISecretProtector
{
    private readonly IDataProtector _protector = provider.CreateProtector("Streamarr.Config.Secrets.v1");

    public string? Protect(string? plaintext)
        => string.IsNullOrEmpty(plaintext) ? null : _protector.Protect(plaintext);

    public string Unprotect(string? ciphertext)
    {
        if (string.IsNullOrEmpty(ciphertext))
            return string.Empty;

        try
        {
            return _protector.Unprotect(ciphertext);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            // Key ring rotated/lost or value corrupted: treat as no usable secret rather
            // than crashing the whole config surface.
            return string.Empty;
        }
    }
}
