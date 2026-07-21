using System.Net;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Options;

/// <summary>Fails startup before unsafe or nonsensical resource settings reach hot paths.</summary>
public sealed class StreamarrOptionsValidator : IValidateOptions<StreamarrOptions>
{
    public ValidateOptionsResult Validate(string? name, StreamarrOptions o)
    {
        var failures = new List<string>();

        if (o.Admin is null || o.TrustedProxies is null || o.TrustedOrigins is null ||
            o.Providers is null || o.Indexers is null ||
            o.Search is null || o.Tmdb is null || o.HealthCheck is null)
        {
            return ValidateOptionsResult.Fail(
                "Streamarr configuration collections and nested option sections must not be null.");
        }

        if (!string.IsNullOrEmpty(o.ApiKey) &&
            (o.ApiKey.Length is < 32 or > 4096 ||
             o.ApiKey.Any(char.IsWhiteSpace) || ContainsControl(o.ApiKey)))
        {
            failures.Add("ApiKey must be empty or 32-4096 characters without whitespace or control characters.");
        }

        if (string.IsNullOrWhiteSpace(o.Admin.Username) || o.Admin.Username.Length > 128 ||
            ContainsControl(o.Admin.Username))
            failures.Add("Admin.Username must be non-empty, at most 128 characters, and contain no control characters.");
        if (!string.IsNullOrEmpty(o.Admin.Password) &&
            (o.Admin.Password.Length is < 12 or > 1024 || ContainsControl(o.Admin.Password)))
            failures.Add("Admin.Password must be 12-1024 characters without control characters when configured.");

        Range(o.AdminSessionTtlSeconds, 60, 30 * 24 * 3600, nameof(o.AdminSessionTtlSeconds));
        Range(o.LoginAttemptsPerMinute, 1, 1_000, nameof(o.LoginAttemptsPerMinute));
        if (o.TrustedProxies.Count > 32 ||
            o.TrustedProxies.Any(value => !IPAddress.TryParse(value, out _)))
        {
            failures.Add("TrustedProxies must contain at most 32 exact IP addresses.");
        }
        else if (o.TrustedProxies.Distinct(StringComparer.OrdinalIgnoreCase).Count() != o.TrustedProxies.Count)
        {
            failures.Add("TrustedProxies must not contain duplicate IP addresses.");
        }
        // Blank entries are tolerated: optional origins are injected via env vars
        // (e.g. Streamarr__TrustedOrigins__0=${CODECRAFT_URL_WEB}), which yield an empty
        // string when unset. A blank can never match a request Origin, so ignoring it is safe.
        var trustedOrigins = o.TrustedOrigins.Where(v => !string.IsNullOrWhiteSpace(v)).ToList();
        if (trustedOrigins.Count > 32 || trustedOrigins.Any(v => !IsHttpUrl(v)))
        {
            failures.Add("TrustedOrigins must contain at most 32 absolute HTTP(S) origins without user-info.");
        }
        else if (trustedOrigins.Distinct(StringComparer.OrdinalIgnoreCase).Count() != trustedOrigins.Count)
        {
            failures.Add("TrustedOrigins must not contain duplicate values.");
        }
        Range(o.ConnectionBudget, 1, 1_000, nameof(o.ConnectionBudget));
        Range(o.ConnectionWarmupCount, 0, 100, nameof(o.ConnectionWarmupCount));
        Range(o.ConnectionIdleTimeoutSeconds, 30, 24 * 3600, nameof(o.ConnectionIdleTimeoutSeconds));
        Range(o.SessionTtlSeconds, 1, 30 * 24 * 3600, nameof(o.SessionTtlSeconds));
        Range(o.EphemeralCacheSizeMb, 1, 67_108_864, nameof(o.EphemeralCacheSizeMb));
        Range(o.SessionSweepIntervalSeconds, 1, 3600, nameof(o.SessionSweepIntervalSeconds));
        Range(o.MaxSessions, 1, 10_000, nameof(o.MaxSessions));
        Range(o.MaxConcurrentStreams, 1, 1_000, nameof(o.MaxConcurrentStreams));
        Range(o.MaxConcurrentResolves, 1, 64, nameof(o.MaxConcurrentResolves));
        Range(o.MaxConcurrentSearches, 1, 64, nameof(o.MaxConcurrentSearches));
        if (!IsHttpProxyUrl(o.IndexerProxy))
        {
            failures.Add(
                "IndexerProxy must be empty or an absolute HTTP proxy URL without credentials, path, query, or fragment.");
        }
        Range(o.MaxFallbackHops, 0, 20, nameof(o.MaxFallbackHops));
        Range(o.HealthCacheTtlSeconds, 0, 30 * 24 * 3600, nameof(o.HealthCacheTtlSeconds));
        Range(o.ArticleReadAheadCount, 1, 100, nameof(o.ArticleReadAheadCount));
        Range(o.ArticleStartupReadAheadCount, 1, 100, nameof(o.ArticleStartupReadAheadCount));
        Range(o.ArticleStartupReadAheadSegments, 1, 100, nameof(o.ArticleStartupReadAheadSegments));
        Range(o.ArticleDownloadRetryCount, 0, 10, nameof(o.ArticleDownloadRetryCount));
        Range(o.RarMaterializationConcurrency, 1, 32, nameof(o.RarMaterializationConcurrency));
        Range(o.MediaMaterializationCacheMaxEntries, 0, 512, nameof(o.MediaMaterializationCacheMaxEntries));
        Range(o.MediaMaterializationCacheSizeMb, 0, 1_048_576, nameof(o.MediaMaterializationCacheSizeMb));
        Range(o.SegmentCacheSizeMb, 0, 1_048_576, nameof(o.SegmentCacheSizeMb));
        if (o.StreamPacingBurstBytes is < 1024 * 1024 or > 4L * 1024 * 1024 * 1024)
            failures.Add("StreamPacingBurstBytes must be between 1 MiB and 4 GiB.");
        Range(o.StreamPacingSustainBytesPerSecond, 256 * 1024, 512 * 1024 * 1024, nameof(o.StreamPacingSustainBytesPerSecond));
        Range(o.FfprobeTimeoutSeconds, 1, 600, nameof(o.FfprobeTimeoutSeconds));
        Range(o.FfprobeEscalatedTimeoutSeconds, 1, 600, nameof(o.FfprobeEscalatedTimeoutSeconds));
        Range(o.FfprobeProbeSizeBytes, 32 * 1024, 64 * 1024 * 1024, nameof(o.FfprobeProbeSizeBytes));
        Range(o.FfprobeAnalyzeDurationMs, 100, 60_000, nameof(o.FfprobeAnalyzeDurationMs));
        Range(o.FfprobeEscalatedProbeSizeBytes, 32 * 1024, 64 * 1024 * 1024, nameof(o.FfprobeEscalatedProbeSizeBytes));
        Range(o.FfprobeEscalatedAnalyzeDurationMs, 100, 60_000, nameof(o.FfprobeEscalatedAnalyzeDurationMs));
        if (o.FfprobeEscalatedProbeSizeBytes < o.FfprobeProbeSizeBytes ||
            o.FfprobeEscalatedAnalyzeDurationMs < o.FfprobeAnalyzeDurationMs)
        {
            failures.Add("Escalated ffprobe budgets must be at least their fast-path budgets.");
        }
        Range(o.MaxConcurrentFfprobe, 1, 32, nameof(o.MaxConcurrentFfprobe));
        Range(o.MaxNzbBytes, 1024, 512 * 1024 * 1024, nameof(o.MaxNzbBytes));
        Range(o.MaxNzbFiles, 1, 100_000, nameof(o.MaxNzbFiles));
        Range(o.MaxNzbSegments, 1, 5_000_000, nameof(o.MaxNzbSegments));
        Range(o.NzbCacheSizeMb, 1, 1_048_576, nameof(o.NzbCacheSizeMb));
        Range(o.NzbCacheMaxEntries, 1, 1_000_000, nameof(o.NzbCacheMaxEntries));
        if (o.NzbCachePath.Length > 4096 || ContainsControl(o.NzbCachePath))
            failures.Add("NzbCachePath must not exceed 4096 characters or contain control characters.");
        if (o.MaxMediaBytes is < 1024 or > 64L * 1024 * 1024 * 1024 * 1024)
            failures.Add("MaxMediaBytes must be between 1 KiB and 64 TiB.");
        Range(o.SearchCacheMaxEntries, 1, 100_000, nameof(o.SearchCacheMaxEntries));
        Range(o.HealthCacheMaxEntries, 1, 1_000_000, nameof(o.HealthCacheMaxEntries));
        Range(o.ReleaseStoreMaxEntries, 1, 1_000_000, nameof(o.ReleaseStoreMaxEntries));
        Range(o.TmdbCacheMaxEntries, 1, 100_000, nameof(o.TmdbCacheMaxEntries));
        Range(o.MaxWatchEvents, 1, 1_000_000, nameof(o.MaxWatchEvents));
        Range(o.DeepHealthCacheSeconds, 1, 600, nameof(o.DeepHealthCacheSeconds));
        if ((long)o.MaxNzbBytes * o.MaxConcurrentResolves > 1024L * 1024 * 1024)
            failures.Add("MaxNzbBytes multiplied by MaxConcurrentResolves must not exceed 1 GiB.");

        Range(o.Search.SearchCacheTtlSeconds, 0, 3600, "Search.SearchCacheTtlSeconds");
        Range(o.Search.PerIndexerTimeoutSeconds, 1, 300, "Search.PerIndexerTimeoutSeconds");
        Range(o.Search.PerIndexerRateLimitMilliseconds, 0, 60_000, "Search.PerIndexerRateLimitMilliseconds");
        Range(o.Search.DefaultLimit, 1, 1000, "Search.DefaultLimit");
        Range(o.Search.MaxResponseBytes, 1024, 128 * 1024 * 1024, "Search.MaxResponseBytes");
        Range(o.Search.MaxIndexersPerSearch, 1, 256, "Search.MaxIndexersPerSearch");
        Range(o.Search.MaxConcurrentIndexerRequests, 1, 64, "Search.MaxConcurrentIndexerRequests");
        Range(o.Search.MaxTransientRetries, 0, 10, "Search.MaxTransientRetries");
        Range(o.Search.RetryBaseDelayMilliseconds, 0, 60_000, "Search.RetryBaseDelayMilliseconds");
        Range(o.Search.RetryMaxDelayMilliseconds, 0, 120_000, "Search.RetryMaxDelayMilliseconds");
        if ((long)o.Search.MaxResponseBytes * o.Search.MaxConcurrentIndexerRequests > 512L * 1024 * 1024)
            failures.Add("Search response size multiplied by concurrent indexer requests must not exceed 512 MiB.");

        Range(o.Tmdb.CacheTtlHours, 0, 8760, "Tmdb.CacheTtlHours");
        Range(o.Tmdb.MaxResponseBytes, 1024, 16 * 1024 * 1024, "Tmdb.MaxResponseBytes");
        Range(o.Tmdb.RequestTimeoutSeconds, 1, 120, "Tmdb.RequestTimeoutSeconds");
        Range(o.Tmdb.MaxConcurrentRequests, 1, 32, "Tmdb.MaxConcurrentRequests");
        if ((long)o.Tmdb.MaxResponseBytes * o.Tmdb.MaxConcurrentRequests > 128L * 1024 * 1024)
            failures.Add("TMDB response size multiplied by concurrent requests must not exceed 128 MiB.");
        if (!IsHttpUrl(o.Tmdb.BaseUrl))
            failures.Add("Tmdb.BaseUrl must be an absolute HTTP(S) URL without user-info.");
        if (!IsHttpUrl(o.Tmdb.ImageBaseUrl))
            failures.Add("Tmdb.ImageBaseUrl must be an absolute HTTP(S) URL without user-info.");
        if (o.Tmdb.ApiKey?.Length > 4096 || ContainsControl(o.Tmdb.ApiKey))
            failures.Add("Tmdb.ApiKey must not exceed 4096 characters or contain control characters.");
        if (o.Tmdb.Language is { Length: > 32 } || ContainsControl(o.Tmdb.Language))
            failures.Add("Tmdb.Language must not exceed 32 characters or contain control characters.");
        if (!IsImageSize(o.Tmdb.PosterSize) || !IsImageSize(o.Tmdb.BackdropSize))
            failures.Add("TMDB image sizes must be non-empty alphanumeric values of at most 32 characters.");

        Range(o.HealthCheck.SampleCount, 1, 1_000, "HealthCheck.SampleCount");
        Range(o.HealthCheck.Concurrency, 1, 100, "HealthCheck.Concurrency");
        if (o.HealthCheck.DeadMissingRatio is <= 0 or > 1)
            failures.Add("HealthCheck.DeadMissingRatio must be greater than 0 and at most 1.");

        foreach (var p in o.Providers)
        {
            if (string.IsNullOrWhiteSpace(p.Name) || p.Name.Length > 128)
                failures.Add("Every provider requires a name of at most 128 characters.");
            if (!IsValidHost(p.Host))
                failures.Add($"Provider '{p.Name}' has an invalid host.");
            if (p.Port is < 1 or > 65535)
                failures.Add($"Provider '{p.Name}' has an invalid port.");
            if (p.MaxConnections is < 1 or > 100)
                failures.Add($"Provider '{p.Name}' maxConnections must be between 1 and 100.");
            if (ContainsControl(p.Username) || ContainsControl(p.Password))
                failures.Add($"Provider '{p.Name}' credentials contain control characters.");
        }

        foreach (var i in o.Indexers)
        {
            if (string.IsNullOrWhiteSpace(i.Name) || i.Name.Length > 128)
                failures.Add("Every indexer requires a name of at most 128 characters.");
            if ((!string.IsNullOrEmpty(i.Id) && (i.Id.Length > 128 || ContainsControl(i.Id))) ||
                ContainsControl(i.Name))
                failures.Add($"Indexer '{i.Name}' has an invalid id or name.");
            if (!IsHttpUrl(i.BaseUrl))
                failures.Add($"Indexer '{i.Name}' requires an absolute HTTP(S) base URL without user-info.");
        }

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);

        void Range(int value, int min, int max, string property)
        {
            if (value < min || value > max)
                failures.Add($"{property} must be between {min} and {max}.");
        }
    }

    internal static bool IsValidHost(string? host)
    {
        if (string.IsNullOrWhiteSpace(host) || host.Length > 253 || ContainsControl(host))
            return false;
        var unbracketed = host.Trim().TrimStart('[').TrimEnd(']');
        return Uri.CheckHostName(unbracketed) != UriHostNameType.Unknown;
    }

    internal static bool IsHttpUrl(string? value)
        => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
           uri.Scheme is "http" or "https" &&
           string.IsNullOrEmpty(uri.UserInfo) &&
           !string.IsNullOrEmpty(uri.Host) &&
           value!.Length <= 2048;

    internal static bool IsHttpProxyUrl(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return true;

        return Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
               uri.Scheme == "http" &&
               string.IsNullOrEmpty(uri.UserInfo) &&
               !string.IsNullOrEmpty(uri.Host) &&
               uri.AbsolutePath == "/" &&
               string.IsNullOrEmpty(uri.Query) &&
               string.IsNullOrEmpty(uri.Fragment) &&
               value.Length <= 2048;
    }

    internal static bool ContainsControl(string? value)
        => value?.Any(char.IsControl) ?? false;

    private static bool IsImageSize(string? value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= 32 && value.All(char.IsLetterOrDigit);
}
