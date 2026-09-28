using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace Streamarr.Server.Viewers.Auth;

/// <summary>Scheme, policy, claim and cookie contract of viewer auth; deliberately disjoint from admin auth.</summary>
public static class ViewerAuth
{
    public const string ModuleId = "viewers";
    public const string Scheme = "StreamarrViewer";
    public const string Policy = "ViewerOnly";
    public const string Role = "viewer";
    public const string AccountType = "viewer";

    public const string AccountTypeClaim = "streamarr_account_type";
    public const string SessionIdClaim = "streamarr_viewer_session";
    public const string PasswordChangeClaim = "streamarr_viewer_password_change";
    public const string MethodClaim = "streamarr_viewer_auth_method";
    public const string DeviceClaim = "streamarr_viewer_device";

    public const string AccessTokenPrefix = "sva_";
    public const string RefreshTokenPrefix = "svr_";
    public const string MfaTokenPrefix = "svm_";

    public const string CookieName = "streamarr_viewer";
    public const string RefreshCookieName = "streamarr_viewer_refresh";
    public const string CookiePath = "/api/v1/viewer";
    public const string RefreshCookiePath = "/api/v1/viewer/auth";

    public const string RateLimitPolicy = "viewer-auth";

    public static string NewToken(string prefix) => prefix + WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    public static bool HasShape(string? token, string prefix)
        => token is { Length: 47 } &&
           token.StartsWith(prefix, StringComparison.Ordinal) &&
           token.AsSpan(prefix.Length).IndexOfAnyExcept("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") < 0;

    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static CookieOptions AccessCookie(bool secure, DateTimeOffset? expires = null) => Cookie(CookiePath, secure, expires);

    public static CookieOptions RefreshCookie(bool secure, DateTimeOffset? expires = null) => Cookie(RefreshCookiePath, secure, expires);

    private static CookieOptions Cookie(string path, bool secure, DateTimeOffset? expires) => new()
    {
        HttpOnly = true,
        Secure = secure,
        SameSite = SameSiteMode.Strict,
        Path = path,
        IsEssential = true,
        Expires = expires,
        MaxAge = expires is { } until ? until - DateTimeOffset.UtcNow : null,
    };
}
