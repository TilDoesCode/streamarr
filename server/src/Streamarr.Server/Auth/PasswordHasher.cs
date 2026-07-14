using System.Globalization;
using System.Security.Cryptography;

namespace Streamarr.Server.Auth;

/// <summary>
/// Versioned PBKDF2-SHA256 password hashing. New hashes use the current work factor;
/// unversioned legacy 100k hashes remain verifiable and are upgraded after login.
/// </summary>
public static class PasswordHasher
{
    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const int LegacyIterations = 100_000;
    internal const int CurrentIterations = 600_000;
    private const string Prefix = "pbkdf2-sha256";

    public static (string Hash, string Salt) Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var derived = Derive(password, salt, CurrentIterations);
        return ($"{Prefix}${CurrentIterations.ToString(CultureInfo.InvariantCulture)}${Convert.ToBase64String(derived)}",
            Convert.ToBase64String(salt));
    }

    public static bool Verify(string password, string hash, string salt)
        => VerifyDetailed(password, hash, salt).Valid;

    public static PasswordVerification VerifyDetailed(string password, string hash, string salt)
    {
        if (string.IsNullOrEmpty(hash) || string.IsNullOrEmpty(salt) || password is null)
            return new PasswordVerification(false, false);

        byte[] expected;
        byte[] saltBytes;
        var iterations = LegacyIterations;
        var needsRehash = true;
        try
        {
            saltBytes = Convert.FromBase64String(salt);
            if (hash.StartsWith(Prefix + '$', StringComparison.Ordinal))
            {
                var parts = hash.Split('$');
                if (parts.Length != 3 || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out iterations) ||
                    iterations is < LegacyIterations or > 5_000_000)
                {
                    return new PasswordVerification(false, false);
                }
                expected = Convert.FromBase64String(parts[2]);
                needsRehash = iterations < CurrentIterations;
            }
            else
            {
                expected = Convert.FromBase64String(hash);
            }
        }
        catch (FormatException)
        {
            return new PasswordVerification(false, false);
        }

        if (saltBytes.Length != SaltBytes || expected.Length != HashBytes)
            return new PasswordVerification(false, false);

        var actual = Derive(password, saltBytes, iterations);
        var valid = CryptographicOperations.FixedTimeEquals(actual, expected);
        return new PasswordVerification(valid, valid && needsRehash);
    }

    private static byte[] Derive(string password, byte[] salt, int iterations)
        => Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, HashBytes);
}

public readonly record struct PasswordVerification(bool Valid, bool NeedsRehash);
