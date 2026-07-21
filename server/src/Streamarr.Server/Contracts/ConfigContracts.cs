using Streamarr.Core.Profiles;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Contracts;

/// <summary>Transactional priority order; every current row id must appear exactly once.</summary>
public sealed record ReorderRequest
{
    public required IReadOnlyList<string> Ids { get; init; }
}

/// <summary>Optional tuning for a real provider throughput test.</summary>
public sealed record ProviderSpeedTestRequest
{
    /// <summary>
    /// Recent article message-id (with or without angle brackets). When omitted, Streamarr
    /// discovers a suitable article through common binary test groups.
    /// </summary>
    public string? MessageId { get; init; }

    /// <summary>Measurement window in seconds (1-15). Defaults to 8.</summary>
    public int? DurationSeconds { get; init; }
}

// ---- Indexers -----------------------------------------------------------------------

/// <summary>Indexer as returned by the config API — the API key is masked, never plaintext.</summary>
public sealed record IndexerResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string BaseUrl { get; init; }
    public string? ApiKey { get; init; }
    public bool HasApiKey { get; init; }
    public IReadOnlyList<int> Categories { get; init; } = [];

    /// <summary>Extra hostnames NZB downloads may use besides the BaseUrl host.</summary>
    public IReadOnlyList<string> AllowedDownloadHosts { get; init; } = [];

    public bool Enabled { get; init; }
    public int Priority { get; init; }

    public static IndexerResponse From(IndexerEntity e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        BaseUrl = e.BaseUrl,
        ApiKey = SecretMasking.Masked(e.ApiKeyEncrypted),
        HasApiKey = !string.IsNullOrEmpty(e.ApiKeyEncrypted),
        Categories = Config.IndexerConfigService.ParseCategories(e.Categories),
        AllowedDownloadHosts = Config.IndexerConfigService.ParseHosts(e.AllowedDownloadHosts),
        Enabled = e.Enabled,
        Priority = e.Priority,
    };
}

// ---- Providers ----------------------------------------------------------------------

/// <summary>Provider as returned by the config API — the password is masked, never plaintext.</summary>
public sealed record ProviderResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Host { get; init; }
    public int Port { get; init; }
    public bool UseSsl { get; init; }
    public string Username { get; init; } = string.Empty;
    public string? Password { get; init; }
    public bool HasPassword { get; init; }
    public int MaxConnections { get; init; }
    public int Priority { get; init; }
    public bool Enabled { get; init; }
    public bool IsBackupOnly { get; init; }

    public static ProviderResponse From(ProviderEntity e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        Host = e.Host,
        Port = e.Port,
        UseSsl = e.UseSsl,
        Username = e.Username,
        Password = SecretMasking.Masked(e.PasswordEncrypted),
        HasPassword = !string.IsNullOrEmpty(e.PasswordEncrypted),
        MaxConnections = e.MaxConnections,
        Priority = e.Priority,
        Enabled = e.Enabled,
        IsBackupOnly = e.IsBackupOnly,
    };
}

// ---- General config -----------------------------------------------------------------

/// <summary>General config as returned by the config API — the TMDB key is masked.</summary>
public sealed record GeneralConfigResponse
{
    public string? TmdbApiKey { get; init; }
    public bool HasTmdbApiKey { get; init; }
    public int SessionTtlSeconds { get; init; }
    public int EphemeralCacheSizeMb { get; init; }
    public int SearchCacheTtlSeconds { get; init; }
    public int SegmentCacheSizeMb { get; init; }
    public int ConnectionBudget { get; init; }
    public bool AddStreamarrBadge { get; init; }
    public bool AddReleaseScoreToName { get; init; }

    public static GeneralConfigResponse From(GeneralConfigEntity e) => new()
    {
        TmdbApiKey = SecretMasking.Masked(e.TmdbApiKeyEncrypted),
        HasTmdbApiKey = !string.IsNullOrEmpty(e.TmdbApiKeyEncrypted),
        SessionTtlSeconds = e.SessionTtlSeconds,
        EphemeralCacheSizeMb = e.EphemeralCacheSizeMb,
        SearchCacheTtlSeconds = e.SearchCacheTtlSeconds,
        SegmentCacheSizeMb = e.SegmentCacheSizeMb,
        ConnectionBudget = e.ConnectionBudget,
        AddStreamarrBadge = e.AddStreamarrBadge,
        AddReleaseScoreToName = e.AddReleaseScoreToName,
    };
}

// ---- API keys -----------------------------------------------------------------------

public sealed record ApiKeyResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Prefix { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? RevokedAt { get; init; }
    public bool Revoked { get; init; }

    public static ApiKeyResponse From(ApiKeyEntity e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        Prefix = e.Prefix,
        CreatedAt = e.CreatedAt,
        RevokedAt = e.RevokedAt,
        Revoked = e.RevokedAt is not null,
    };
}

public sealed record CreateApiKeyRequest
{
    public required string Name { get; init; }
}

/// <summary>Returned once when a key is minted; carries the one-time plaintext token.</summary>
public sealed record CreatedApiKeyResponse
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Token { get; init; }
}

// ---- Events -------------------------------------------------------------------------

/// <summary>POST /api/v1/events body (BRIEF §6.2).</summary>
public sealed record EventRequest
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }

    /// <summary>"start" | "progress" | "stop".</summary>
    public required string Event { get; init; }

    public long? PositionTicks { get; init; }

    /// <summary>Originating front-end ("jellyfin" | "web" | …).</summary>
    public string? Source { get; init; }

    public string? PlaybackSessionId { get; init; }
    public string? ExternalUserId { get; init; }
    public string? ExternalUserName { get; init; }
    public string? DeviceName { get; init; }
}
