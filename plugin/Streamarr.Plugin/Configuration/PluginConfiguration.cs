using MediaBrowser.Model.Plugins;

namespace Streamarr.Plugin.Configuration;

/// <summary>
/// Deliberately minimal plugin configuration (BRIEF §8.1). Real configuration —
/// indexers, providers, quality profiles — lives in the Streamarr Management UI.
/// The plugin only needs to know how to reach the Core Server and how to behave.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    public const int MinEphemeralTtlMinutes = 5;
    public const int MaxEphemeralTtlMinutes = 43_200;
    public const int MaxPinnedQueryLength = 256;
    public const int MaxServerUrlLength = 2048;
    // Keep this aligned with Core's validated static-key ceiling.
    public const int MaxApiKeyLength = 4096;
    public const int MaxProfileIdLength = 128;

    private int _ephemeralTtlMinutes = 720;
    private string _pinnedWorkQuery = "Big Buck Bunny";
    private string _serverUrl = "http://streamarr:8080";
    private string _apiKey = string.Empty;
    private string _profileId = string.Empty;

    /// <summary>Base URL of the Streamarr Core Server, e.g. <c>http://streamarr:8080</c>.</summary>
    public string ServerUrl
    {
        get => _serverUrl;
        set
        {
            var candidate = (value ?? string.Empty).Trim().TrimEnd('/');
            if (!IsValidServerUrl(candidate))
                throw new ArgumentException("Core Server URL must be a bounded absolute HTTP(S) URL without credentials.", nameof(value));
            _serverUrl = candidate;
        }
    }

    /// <summary>Machine API key (Bearer) issued by the Core Server for headless clients.</summary>
    public string ApiKey
    {
        get => _apiKey;
        set
        {
            var candidate = value ?? string.Empty;
            if (candidate.Length > MaxApiKeyLength || candidate.Any(char.IsControl))
                throw new ArgumentException("API key is too long or contains control characters.", nameof(value));
            _apiKey = candidate;
        }
    }

    /// <summary>
    /// TTL (minutes) after which unused ephemeral items are eligible for cleanup.
    /// Cleanup itself lands in M6; the value is surfaced now so operators can set it.
    /// </summary>
    public int EphemeralTtlMinutes
    {
        get => _ephemeralTtlMinutes;
        set => _ephemeralTtlMinutes = Math.Clamp(value, MinEphemeralTtlMinutes, MaxEphemeralTtlMinutes);
    }

    /// <summary>
    /// Master switch for search interception (M6). Off by default; a broken filter must
    /// never break native Jellyfin search (BRIEF §8.2, §11).
    /// </summary>
    public bool InterceptionEnabled { get; set; }

    /// <summary>
    /// Optional Core Server quality-profile id to pass through on searches. Empty = use
    /// the server's default profile.
    /// </summary>
    public string ProfileId
    {
        get => _profileId;
        set
        {
            var candidate = (value ?? string.Empty).Trim();
            if (candidate.Length > MaxProfileIdLength || candidate.Any(char.IsControl))
                throw new ArgumentException("Profile id is too long or contains control characters.", nameof(value));
            _profileId = candidate;
        }
    }

    /// <summary>
    /// Fixed query used by the "sync one pinned work" bootstrap path (BRIEF §8.3 /
    /// Milestone 5 thin-slice). Materializes exactly one ephemeral item for smoke-testing
    /// the playback path end to end without the search interception.
    /// </summary>
    public string PinnedWorkQuery
    {
        get => _pinnedWorkQuery;
        set
        {
            var normalized = (value ?? string.Empty).Trim();
            if (normalized.Any(char.IsControl))
                throw new ArgumentException("Pinned query contains control characters.", nameof(value));
            _pinnedWorkQuery = normalized[..Math.Min(normalized.Length, MaxPinnedQueryLength)];
        }
    }

    internal static bool IsValidServerUrl(string value)
        => value.Length is > 0 and <= MaxServerUrlLength
           && !value.Any(char.IsControl)
           && Uri.TryCreate(value, UriKind.Absolute, out var uri)
           && (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
               || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
           && !string.IsNullOrWhiteSpace(uri.Host)
           && string.IsNullOrEmpty(uri.UserInfo)
           && string.IsNullOrEmpty(uri.Query)
           && string.IsNullOrEmpty(uri.Fragment);
}
