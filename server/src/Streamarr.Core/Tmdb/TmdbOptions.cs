namespace Streamarr.Core.Tmdb;

/// <summary>
/// TMDB client configuration (BRIEF §6.3). The API key is empty until the owner
/// supplies one (via appsettings.Local.json or, from M3, the config API); with no key
/// the client short-circuits every lookup to <c>null</c> so search still works.
/// </summary>
public sealed class TmdbOptions
{
    public string ApiKey { get; set; } = string.Empty;

    public string BaseUrl { get; set; } = "https://api.themoviedb.org/3";

    public string ImageBaseUrl { get; set; } = "https://image.tmdb.org/t/p";

    public string PosterSize { get; set; } = "w500";

    public string BackdropSize { get; set; } = "w1280";

    /// <summary>Optional ISO 639-1 language for TMDB responses (e.g. "en-US").</summary>
    public string? Language { get; set; }

    /// <summary>Result-cache lifetime; TMDB metadata is cached aggressively (BRIEF §6.1).</summary>
    public int CacheTtlHours { get; set; } = 24;

    /// <summary>Maximum decompressed JSON response body accepted from TMDB.</summary>
    public int MaxResponseBytes { get; set; } = 4 * 1024 * 1024;

    /// <summary>Hard lifetime for one shared upstream lookup, including admission wait.</summary>
    public int RequestTimeoutSeconds { get; set; } = 20;

    /// <summary>Maximum number of TMDB requests in flight across all callers.</summary>
    public int MaxConcurrentRequests { get; set; } = 4;

    public TimeSpan CacheTtl => TimeSpan.FromHours(Math.Max(0, CacheTtlHours));

    public TimeSpan RequestTimeout => TimeSpan.FromSeconds(Math.Max(1, RequestTimeoutSeconds));
}
