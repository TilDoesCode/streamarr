using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
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
    public const string IndexerProxyEnvironmentVariable = "INDEXER_PROXY";

    /// <summary>
    /// Bootstrap machine API key for bearer auth (BRIEF §6.4). Accepted alongside any
    /// key minted via the config API; empty disables this static key.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>SQLite connection string; empty defaults to a file next to the app.</summary>
    public string ConnectionString { get; set; } = string.Empty;

    /// <summary>
    /// First-run admin bootstrap (BRIEF §6.4). Username defaults to "admin"; the password
    /// is taken from here or the STREAMARR_ADMIN_PASSWORD env var. Development generates and
    /// logs a random fallback; other environments fail fast. Only used when the users table is empty.
    /// </summary>
    public AdminBootstrapOptions Admin { get; set; } = new();

    /// <summary>Lifetime of an admin session JWT issued by <c>POST /api/v1/auth/login</c>.</summary>
    public int AdminSessionTtlSeconds { get; set; } = 3600;

    /// <summary>Per-client fixed-window limit for anonymous login attempts.</summary>
    public int LoginAttemptsPerMinute { get; set; } = 5;

    /// <summary>
    /// Exact reverse-proxy IP addresses permitted to supply forwarded client and
    /// protocol headers. Loopback proxies remain trusted by the framework defaults.
    /// </summary>
    public List<string> TrustedProxies { get; set; } = [];

    /// <summary>
    /// Additional absolute origins (<c>scheme://host[:port]</c>) accepted by the CSRF
    /// same-origin check for cookie-authenticated unsafe requests. Needed when the
    /// Management UI is served from a different public URL than the Core Server sees —
    /// e.g. behind a TLS-terminating tunnel or Codecraft's forwarded per-app URLs, where
    /// the browser's Origin can never match the origin Kestrel reconstructs locally.
    /// Empty by default; blank entries are ignored (unset via env injection).
    /// </summary>
    public List<string> TrustedOrigins { get; set; } = [];

    /// <summary>
    /// Directory the Data Protection key ring (secret encryption) persists to; empty
    /// defaults to a "keys" folder next to the app so ciphertext survives restarts.
    /// </summary>
    public string DataProtectionKeysPath { get; set; } = string.Empty;

    /// <summary>Global NNTP connection budget shared across all sessions.</summary>
    public int ConnectionBudget { get; set; } = 20;

    public int SessionTtlSeconds { get; set; } = 3600;

    public int SessionSweepIntervalSeconds { get; set; } = 30;

    /// <summary>Maximum number of simultaneously live capability sessions.</summary>
    public int MaxSessions { get; set; } = 64;

    /// <summary>Maximum number of concurrently open HTTP stream bodies.</summary>
    public int MaxConcurrentStreams { get; set; } = 128;

    /// <summary>Maximum number of full NZB/health/materialization resolve pipelines in flight.</summary>
    public int MaxConcurrentResolves { get; set; } = 4;

    /// <summary>Maximum number of concurrent indexer fan-out searches.</summary>
    public int MaxConcurrentSearches { get; set; } = 4;

    /// <summary>
    /// Optional HTTP proxy used only for Newznab requests and NZB retrieval. The
    /// top-level INDEXER_PROXY environment variable overrides this setting.
    /// </summary>
    public string IndexerProxy { get; set; } = string.Empty;

    /// <summary>
    /// Maximum number of automatic fallback hops when a release resolves dead
    /// (BRIEF §10-M7). Bounded so a fully-dead work fails fast instead of walking
    /// an arbitrarily long release list.
    /// </summary>
    public int MaxFallbackHops { get; set; } = 3;

    /// <summary>
    /// How long a dead classification is remembered and fed back into ranking +
    /// fallback selection (BRIEF §10-M7). Zero disables the health cache.
    /// </summary>
    public int HealthCacheTtlSeconds { get; set; } = 1800;

    /// <summary>Segments to read ahead while streaming (nzbdav's articleBufferSize).</summary>
    public int ArticleReadAheadCount { get; set; } = 3;

    /// <summary>Retries after a decoded article transfer or validation failure.</summary>
    public int ArticleDownloadRetryCount { get; set; } = 2;

    /// <summary>Maximum process-wide decoded article cache size in mebibytes.</summary>
    public int SegmentCacheSizeMb { get; set; } = 512;

    public string FfprobePath { get; set; } = "ffprobe";

    public int FfprobeTimeoutSeconds { get; set; } = 60;

    /// <summary>Maximum number of ffprobe child processes running at once.</summary>
    public int MaxConcurrentFfprobe { get; set; } = 2;

    /// <summary>Maximum downloaded NZB size before parsing.</summary>
    public int MaxNzbBytes { get; set; } = 64 * 1024 * 1024;

    public int MaxNzbFiles { get; set; } = 10_000;
    public int MaxNzbSegments { get; set; } = 1_000_000;

    /// <summary>Directory for persistent, parsed-on-read NZB cache files.</summary>
    public string NzbCachePath { get; set; } = string.Empty;

    /// <summary>Maximum total size of cached NZB source documents in mebibytes.</summary>
    public int NzbCacheSizeMb { get; set; } = 1024;

    /// <summary>Maximum number of releases retained in the persistent NZB cache.</summary>
    public int NzbCacheMaxEntries { get; set; } = 2_000;

    /// <summary>Maximum decoded size of one materialized media file.</summary>
    public long MaxMediaBytes { get; set; } = 16L * 1024 * 1024 * 1024 * 1024;

    /// <summary>
    /// Explicit test/development escape hatch for local NZB paths. Disabled by default;
    /// production indexer results must resolve to HTTP(S) on their configured origin.
    /// </summary>
    public bool AllowLocalNzbFiles { get; set; }

    public int SearchCacheMaxEntries { get; set; } = 1_000;
    public int HealthCacheMaxEntries { get; set; } = 10_000;
    public int ReleaseStoreMaxEntries { get; set; } = 10_000;
    public int TmdbCacheMaxEntries { get; set; } = 5_000;

    /// <summary>Maximum retained playback-event rows; oldest rows are pruned on write.</summary>
    public int MaxWatchEvents { get; set; } = 10_000;

    /// <summary>Lifetime of a shared deep dependency-health snapshot.</summary>
    public int DeepHealthCacheSeconds { get; set; } = 30;

    /// <summary>Priority-ordered provider list (DECISIONS.md #6: multi-provider from M1).</summary>
    public List<UsenetProviderOptions> Providers { get; set; } = [];

    /// <summary>Configured Newznab indexers (BRIEF §6.3); seeds the in-memory config store.</summary>
    public List<IndexerOptions> Indexers { get; set; } = [];

    /// <summary>Fan-out tunables: cache TTL, per-indexer timeout, rate limit (BRIEF §6.1).</summary>
    public IndexerSearchOptions Search { get; set; } = new();

    /// <summary>TMDB matcher config: API key, image sizes, cache TTL (BRIEF §6.1 / §6.3).</summary>
    public TmdbOptions Tmdb { get; set; } = new();

    public HealthCheckOptions HealthCheck { get; set; } = new();
}

/// <summary>First-run admin credentials (BRIEF §6.4). Seeds the extensible users table.</summary>
public sealed class AdminBootstrapOptions
{
    public string Username { get; set; } = "admin";

    /// <summary>Plaintext bootstrap password; empty is permitted only in Development.</summary>
    public string Password { get; set; } = string.Empty;
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
