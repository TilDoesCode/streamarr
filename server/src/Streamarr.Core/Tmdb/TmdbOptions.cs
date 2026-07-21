namespace Streamarr.Core.Tmdb;

/// <summary>
/// TMDB client configuration (BRIEF §6.3). The credential is empty until the owner
/// supplies a v3 API key or API Read Access Token; with no credential the client
/// short-circuits every lookup to <c>null</c> so diagnostic search still works.
/// </summary>
public sealed class TmdbOptions
{
    private CredentialState _credential = new(string.Empty, 0);

    /// <summary>
    /// Atomically published credential and generation. Consumers that need both values
    /// can take one snapshot instead of observing half of a credential replacement.
    /// </summary>
    public (string ApiKey, long Revision) CredentialSnapshot
    {
        get
        {
            var state = Volatile.Read(ref _credential);
            return (state.Value, state.Revision);
        }
    }

    /// <summary>
    /// A TMDB v3 API key or v4 API Read Access Token. Kept under the historical
    /// <c>ApiKey</c> property name for configuration compatibility.
    /// </summary>
    public string ApiKey
    {
        get => CredentialSnapshot.ApiKey;
        set
        {
            var normalized = NormalizeCredential(value);
            while (true)
            {
                var previous = Volatile.Read(ref _credential);
                if (string.Equals(previous.Value, normalized, StringComparison.Ordinal))
                    return;

                var next = new CredentialState(normalized, previous.Revision + 1);
                if (ReferenceEquals(
                        Interlocked.CompareExchange(ref _credential, next, previous),
                        previous))
                {
                    return;
                }
            }
        }
    }

    /// <summary>
    /// Changes whenever the live credential changes. Cache decorators include this
    /// revision in their key so a miss made with an old credential cannot survive a
    /// credential replacement.
    /// </summary>
    public long CredentialRevision => CredentialSnapshot.Revision;

    private sealed record CredentialState(string Value, long Revision);

    public string BaseUrl { get; set; } = "https://api.themoviedb.org/3";

    public string ImageBaseUrl { get; set; } = "https://image.tmdb.org/t/p";

    public string PosterSize { get; set; } = "w780";

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

    /// <summary>
    /// Extra attempts made after a transient TMDB failure (HTTP 408/429/5xx or a
    /// network/parse error) before the lookup surfaces as a miss. A poster URL is only
    /// as good as the metadata request that carries it, so a single dropped request must
    /// not leave a work permanently art-less while its neighbours load.
    /// </summary>
    public int MaxTransientRetries { get; set; } = 3;

    /// <summary>Base delay for the first retry; subsequent retries back off exponentially with jitter.</summary>
    public int RetryBaseDelayMilliseconds { get; set; } = 200;

    /// <summary>Upper bound on any single backoff wait, so a large <c>Retry-After</c> cannot stall a lookup.</summary>
    public int RetryMaxDelayMilliseconds { get; set; } = 5_000;

    public TimeSpan CacheTtl => TimeSpan.FromHours(Math.Max(0, CacheTtlHours));

    public int TransientRetryCount => Math.Clamp(MaxTransientRetries, 0, 10);

    public TimeSpan RetryBaseDelay => TimeSpan.FromMilliseconds(Math.Clamp(RetryBaseDelayMilliseconds, 0, 60_000));

    public TimeSpan RetryMaxDelay =>
        TimeSpan.FromMilliseconds(Math.Clamp(RetryMaxDelayMilliseconds, RetryBaseDelayMilliseconds, 120_000));

    public TimeSpan RequestTimeout => TimeSpan.FromSeconds(Math.Max(1, RequestTimeoutSeconds));

    public static string NormalizeCredential(string? credential)
    {
        var normalized = credential?.Trim() ?? string.Empty;
        const string bearerPrefix = "Bearer ";
        return normalized.StartsWith(bearerPrefix, StringComparison.OrdinalIgnoreCase)
            ? normalized[bearerPrefix.Length..].Trim()
            : normalized;
    }

    /// <summary>
    /// TMDB API Read Access Tokens are JWTs and must be sent in the Authorization header.
    /// Traditional v3 API keys have no dot-separated JWT structure and remain query params.
    /// </summary>
    public static bool IsBearerCredential(string? credential)
    {
        var normalized = NormalizeCredential(credential);
        var firstDot = normalized.IndexOf('.');
        var secondDot = firstDot < 0 ? -1 : normalized.IndexOf('.', firstDot + 1);
        return firstDot > 0
               && secondDot > firstDot + 1
               && secondDot < normalized.Length - 1
               && normalized.IndexOf('.', secondDot + 1) < 0;
    }
}
