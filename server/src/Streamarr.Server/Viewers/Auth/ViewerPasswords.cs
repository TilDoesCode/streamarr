using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Streamarr.Server.Viewers.Auth;

/// <summary>Username, password and generated-credential rules for viewer accounts.</summary>
public static partial class ViewerPasswords
{
    private const string GeneratedAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    public const int MaxLength = 256;

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$", RegexOptions.CultureInvariant)]
    private static partial Regex UsernamePattern();

    public static bool IsValidUsername(string? username) => username is not null && UsernamePattern().IsMatch(username);

    public static string NormalizeUsername(string username) => username.Trim().ToUpperInvariant();

    public static string? Problem(string? password, string username, ViewerSettings settings)
    {
        if (string.IsNullOrEmpty(password) || password.Length < settings.PasswordMinLength)
            return $"The password must be at least {settings.PasswordMinLength} characters long.";
        if (password.Length > MaxLength)
            return $"The password must not exceed {MaxLength} characters.";
        if (password.Any(char.IsControl))
            return "The password must not contain control characters.";
        if (string.Equals(password, username, StringComparison.OrdinalIgnoreCase))
            return "The password must not equal the username.";
        if (password.Distinct().Count() < 3)
            return "The password is too repetitive.";
        return null;
    }

    public static string Generate(int minLength = 14)
    {
        var groups = Math.Max(3, (minLength + 5) / 5);
        return string.Join('-', Enumerable.Range(0, groups).Select(_ => RandomNumberGenerator.GetString(GeneratedAlphabet, 4)));
    }
}
