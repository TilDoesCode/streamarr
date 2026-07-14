namespace Streamarr.Server.Auth;

/// <summary>Browser admin-session cookie contract and CSRF-authentication marker.</summary>
public static class AdminAuthCookie
{
    public const string Name = "streamarr_admin";
    public const string MethodClaim = "streamarr_auth_method";
    public const string MethodValue = "cookie";

    public static CookieOptions Options(bool secure, DateTimeOffset? expires = null) => new()
    {
        HttpOnly = true,
        Secure = secure,
        SameSite = SameSiteMode.Strict,
        Path = "/",
        IsEssential = true,
        Expires = expires,
        MaxAge = expires is { } until ? until - DateTimeOffset.UtcNow : null,
    };
}
