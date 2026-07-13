namespace Streamarr.Server.Auth;

/// <summary>
/// Authentication scheme + authorization constants for the two-mode auth model
/// (BRIEF §6.4). Machine bearer keys carry <see cref="Machine"/>; admin session JWTs
/// carry <see cref="Admin"/>. The <see cref="AdminPolicy"/> gates /config and /debug so
/// machine keys can never reach them.
/// </summary>
public static class AuthRoles
{
    /// <summary>The single custom authentication scheme (API keys + admin JWTs).</summary>
    public const string Scheme = "Streamarr";

    /// <summary>Headless clients (Jellyfin plugin, future clients). Search/resolve/stream/events/caps.</summary>
    public const string Machine = "machine";

    /// <summary>Management UI operators. Everything, including /config and /debug.</summary>
    public const string Admin = "admin";

    /// <summary>Authorization policy required by config + debug endpoints.</summary>
    public const string AdminPolicy = "AdminOnly";
}
