using MediaBrowser.Model.Plugins;

namespace Streamarr.Plugin.Configuration;

/// <summary>
/// Deliberately minimal plugin configuration (BRIEF §8.1). Real configuration —
/// indexers, providers, quality profiles — lives in the Streamarr Management UI.
/// The plugin only needs to know how to reach the Core Server and how to behave.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Base URL of the Streamarr Core Server, e.g. <c>http://streamarr:8080</c>.</summary>
    public string ServerUrl { get; set; } = "http://streamarr:8080";

    /// <summary>Machine API key (Bearer) issued by the Core Server for headless clients.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// TTL (minutes) after which unused ephemeral items are eligible for cleanup.
    /// Cleanup itself lands in M6; the value is surfaced now so operators can set it.
    /// </summary>
    public int EphemeralTtlMinutes { get; set; } = 720;

    /// <summary>
    /// Master switch for search interception (M6). Off by default; a broken filter must
    /// never break native Jellyfin search (BRIEF §8.2, §11).
    /// </summary>
    public bool InterceptionEnabled { get; set; }

    /// <summary>
    /// Optional Core Server quality-profile id to pass through on searches. Empty = use
    /// the server's default profile.
    /// </summary>
    public string ProfileId { get; set; } = string.Empty;

    /// <summary>
    /// Fixed query used by the "sync one pinned work" bootstrap path (BRIEF §8.3 /
    /// Milestone 5 thin-slice). Materializes exactly one ephemeral item for smoke-testing
    /// the playback path end to end without the search interception.
    /// </summary>
    public string PinnedWorkQuery { get; set; } = "Big Buck Bunny";
}
