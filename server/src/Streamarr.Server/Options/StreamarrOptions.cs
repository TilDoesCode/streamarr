using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Usenet.Models;

namespace Streamarr.Server.Options;

/// <summary>
/// Server configuration (BRIEF §6.3). Bound from the "Streamarr" section;
/// appsettings.Local.json (git-ignored) carries real provider credentials.
/// The config API + Management UI take over CRUD of these values in M3/M4.
/// </summary>
public sealed class StreamarrOptions
{
    public const string SectionName = "Streamarr";

    /// <summary>
    /// Stub machine API key for bearer auth (real machine/admin auth lands in M3,
    /// BRIEF §6.4). Empty means every authenticated endpoint rejects requests.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>Global NNTP connection budget shared across all sessions.</summary>
    public int ConnectionBudget { get; set; } = 20;

    public int SessionTtlSeconds { get; set; } = 3600;

    public int SessionSweepIntervalSeconds { get; set; } = 30;

    /// <summary>Segments to read ahead while streaming (nzbdav's articleBufferSize).</summary>
    public int ArticleReadAheadCount { get; set; } = 3;

    public string FfprobePath { get; set; } = "ffprobe";

    public int FfprobeTimeoutSeconds { get; set; } = 60;

    /// <summary>Priority-ordered provider list (DECISIONS.md #6: multi-provider from M1).</summary>
    public List<UsenetProviderOptions> Providers { get; set; } = [];

    /// <summary>Configured Newznab indexers (BRIEF §6.3); seeds the in-memory config store.</summary>
    public List<IndexerOptions> Indexers { get; set; } = [];

    /// <summary>Fan-out tunables: cache TTL, per-indexer timeout, rate limit (BRIEF §6.1).</summary>
    public IndexerSearchOptions Search { get; set; } = new();

    public HealthCheckOptions HealthCheck { get; set; } = new();
}

/// <summary>Config-bindable mirror of <see cref="IndexerConfig"/> (BRIEF §6.3).</summary>
public sealed class IndexerOptions
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public List<int> Categories { get; set; } = [];
    public bool Enabled { get; set; } = true;
    public int Priority { get; set; }

    public IndexerConfig ToConfig() => new()
    {
        // fall back to the name as a stable id when the config omits one
        Id = string.IsNullOrWhiteSpace(Id) ? Name : Id,
        Name = Name,
        BaseUrl = BaseUrl,
        ApiKey = ApiKey,
        Categories = Categories.ToArray(),
        Enabled = Enabled,
        Priority = Priority,
    };
}

public sealed class UsenetProviderOptions
{
    public string Name { get; set; } = string.Empty;
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; } = 563;
    public bool UseSsl { get; set; } = true;
    public string Username { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public int MaxConnections { get; set; } = 10;
    public int Priority { get; set; }
    public UsenetProviderType Type { get; set; } = UsenetProviderType.Pooled;

    public UsenetProvider ToProvider() => new()
    {
        Name = Name,
        Host = Host,
        Port = Port,
        UseSsl = UseSsl,
        Username = Username,
        Password = Password,
        MaxConnections = MaxConnections,
        Priority = Priority,
        Type = Type,
    };
}

/// <summary>Sampling + classification knobs for the NNTP STAT health check.</summary>
public sealed class HealthCheckOptions
{
    /// <summary>Maximum segments STAT'ed per release (evenly spread, incl. first/last).</summary>
    public int SampleCount { get; set; } = 24;

    public int Concurrency { get; set; } = 8;

    /// <summary>Missing-sample ratio at or above which a release is dead (below: degraded).</summary>
    public double DeadMissingRatio { get; set; } = 0.5;
}
