namespace Streamarr.Server.Tunnels;

/// <summary>Base64 handling of the 32-byte Curve25519 keys WireGuard configurations carry.</summary>
internal static class WireGuardKeys
{
    public const int KeyLength = 32;

    /// <summary>True when <paramref name="base64"/> decodes to exactly 32 bytes.</summary>
    public static bool TryParse(string? base64, out byte[] key)
    {
        key = [];
        if (string.IsNullOrWhiteSpace(base64) || base64.Length > 64)
            return false;
        var buffer = new byte[48];
        if (!Convert.TryFromBase64String(base64.Trim(), buffer, out var written) || written != KeyLength)
            return false;
        key = buffer[..KeyLength];
        return true;
    }

    public static bool IsValid(string? base64) => TryParse(base64, out _);

    /// <summary>Canonical base64 of a parsed key (strips whitespace, fixes padding).</summary>
    public static string Normalize(string base64)
        => TryParse(base64, out var key) ? Convert.ToBase64String(key) : base64.Trim();

    /// <summary>The base64 public key of a base64 private key, or null when the private key is not a valid key.</summary>
    public static string? PublicKeyOf(string? privateKeyBase64)
        => TryParse(privateKeyBase64, out var key) ? Convert.ToBase64String(Curve25519.PublicKey(key)) : null;
}
