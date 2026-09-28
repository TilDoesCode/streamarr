using System.Security.Cryptography;
using System.Text;
using OtpNet;

namespace Streamarr.Server.Viewers.Auth;

/// <summary>RFC 6238 TOTP (Otp.NET) plus single-use recovery codes for viewer two-factor auth.</summary>
public static class ViewerTotp
{
    private const string RecoveryAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    public const int RecoveryCodeCount = 10;

    public static string NewSecret() => Base32Encoding.ToString(KeyGeneration.GenerateRandomKey(20));

    public static string ProvisioningUri(string secret, string issuer, string account)
        => new OtpUri(OtpType.Totp, secret, account, issuer).ToString();

    /// <summary>Returns the matched time step, or null; callers must reject steps not newer than the last used one.</summary>
    public static long? Verify(string secret, string code, DateTimeOffset now)
    {
        var normalized = NormalizeTotp(code);
        if (normalized is null)
            return null;
        var totp = new Totp(Base32Encoding.ToBytes(secret));
        return totp.VerifyTotp(now.UtcDateTime, normalized, out var step, new VerificationWindow(previous: 1, future: 1))
            ? step
            : null;
    }

    public static bool LooksLikeTotp(string code) => NormalizeTotp(code) is not null;

    public static string? NormalizeTotp(string? code)
    {
        if (code is null)
            return null;
        var digits = code.Replace(" ", string.Empty, StringComparison.Ordinal);
        return digits.Length == 6 && digits.All(char.IsAsciiDigit) ? digits : null;
    }

    public static IReadOnlyList<string> NewRecoveryCodes()
        => Enumerable.Range(0, RecoveryCodeCount)
            .Select(_ => $"{RandomString(5)}-{RandomString(5)}")
            .ToList();

    public static string HashRecoveryCode(string code)
    {
        var normalized = new string(code.Where(char.IsAsciiLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("viewer-recovery:" + normalized)));
    }

    private static string RandomString(int length)
        => RandomNumberGenerator.GetString(RecoveryAlphabet, length);
}
