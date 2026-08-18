namespace Streamarr.Server.Logging;

internal sealed class JellyfinLogOptions
{
    public const string ConfigurationSection = "Streamarr:Jellyfin";

    /// <summary>
    /// Jellyfin's externally reachable base URL, optionally including its configured
    /// base path (for example <c>http://jellyfin:8096/jellyfin</c>).
    /// </summary>
    public string? BaseUrl { get; set; }

    /// <summary>
    /// An administrator API key used only in Jellyfin's canonical authorization
    /// header. It is never placed in a URI or returned by the log source.
    /// </summary>
    public string? ApiKey { get; set; }
}
