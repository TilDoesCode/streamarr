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

    /// <summary>Connections proactively opened for each pooled provider after startup.</summary>
    public int ConnectionWarmupCount { get; set; } = 20;

    /// <summary>How long an authenticated NNTP connection may remain idle before reaping.</summary>
    public int ConnectionIdleTimeoutSeconds { get; set; } = 120;

    /// <summary>
    /// Hard maximum age of an ephemeral file capability. Unlike the old sliding session TTL,
    /// reads affect LRU ordering but never extend this deadline.
    /// </summary>
    public int SessionTtlSeconds { get; set; } = 86_400;

    /// <summary>
    /// Logical decoded-file budget for ephemeral capabilities, in mebibytes. Admission evicts
    /// whole least-recently-accessed files until the new file fits. One file larger than the
    /// budget is still admitted after older files are removed.
    /// </summary>
    public int EphemeralCacheSizeMb { get; set; } = 102_400;

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

    /// <summary>Temporary read-ahead window used for the first articles of a stream.</summary>
    public int ArticleStartupReadAheadCount { get; set; } = 8;

    /// <summary>Number of leading articles that use the larger startup window.</summary>
    public int ArticleStartupReadAheadSegments { get; set; } = 8;

    /// <summary>Retries after a decoded article transfer or validation failure.</summary>
    public int ArticleDownloadRetryCount { get; set; } = 2;

    /// <summary>Maximum RAR volumes whose size/header probes may run concurrently.</summary>
    public int RarMaterializationConcurrency { get; set; } = 20;

    /// <summary>Maximum immutable media/RAR materializations retained in process.</summary>
    public int MediaMaterializationCacheMaxEntries { get; set; } = 32;

    /// <summary>Maximum estimated memory retained by immutable media/RAR materializations, in mebibytes.</summary>
    public int MediaMaterializationCacheSizeMb { get; set; } = 64;

    /// <summary>Maximum process-wide decoded article cache size in mebibytes.</summary>
    public int SegmentCacheSizeMb { get; set; } = 512;

    /// <summary>
    /// Paces each open stream after its startup burst so a single consumer — typically an
    /// unthrottled ffmpeg stream-copy racing the whole file — cannot monopolize CPU, NNTP
    /// connections and provider bandwidth. Jellyfin's own transcode throttler never engages
    /// for HTTP inputs (TranscodeManager.EnableThrottling requires MediaProtocol.File), so
    /// the server must pace delivery instead (measured: unpaced transcodes pull the entire
    /// release at wire speed and starve concurrent playback into minutes of TTFF).
    /// </summary>
    public bool StreamPacingEnabled { get; set; } = true;

    /// <summary>Bytes each stream request may read unpaced (keeps first frame, seeks and ffprobe instant).</summary>
    public long StreamPacingBurstBytes { get; set; } = 96L * 1024 * 1024;

    /// <summary>
    /// Sustained per-stream delivery floor after the burst, in bytes per second. Sessions with
    /// probed media above this bitrate are automatically raised to twice their average byte rate.
    /// </summary>
    public int StreamPacingSustainBytesPerSecond { get; set; } = 6 * 1024 * 1024;

    public string FfprobePath { get; set; } = "ffprobe";

    public int FfprobeTimeoutSeconds { get; set; } = 60;

    /// <summary>
    /// Hard ceiling on the escalated ffprobe pass, kept well below <see cref="FfprobeTimeoutSeconds"/>.
    /// Escalation only enriches the runtime/duration once the fast pass already has the codec streams
    /// that drive the player's direct-play/remux decision, so it must never dominate time-to-first-frame
    /// or, on timeout, discard the streams (which would force the player into a full re-encode).
    /// </summary>
    public int FfprobeEscalatedTimeoutSeconds { get; set; } = 8;

    /// <summary>Fast-path ffprobe input byte budget before one bounded escalation.</summary>
    public int FfprobeProbeSizeBytes { get; set; } = 1024 * 1024;

    /// <summary>Fast-path ffprobe analysis time budget, in milliseconds.</summary>
    public int FfprobeAnalyzeDurationMs { get; set; } = 2_000;

    /// <summary>Second and final ffprobe input byte budget after a fast-path miss.</summary>
    public int FfprobeEscalatedProbeSizeBytes { get; set; } = 5 * 1024 * 1024;

    /// <summary>Second and final ffprobe analysis time budget, in milliseconds.</summary>
    public int FfprobeEscalatedAnalyzeDurationMs { get; set; } = 5_000;

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

    /// <summary>
    /// Maximum retained stream-attempt history rows (permanent debugging console —
    /// resolve + repair + session-lifecycle timeline per stream). Oldest *closed* rows
    /// are pruned on write; a still-open/live row is never an eviction candidate.
    /// </summary>
    public int MaxRetainedStreams { get; set; } = 50;

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

    /// <summary>Low-priority background completion and next-episode pre-download policy.</summary>
    public PreDownloadOptions PreDownload { get; set; } = new();

    public HealthCheckOptions HealthCheck { get; set; } = new();

    /// <summary>PAR2-based repair pipeline (dynamic mid-stream repair + resolve-time jobs).</summary>
    public RepairOptions Repair { get; set; } = new();
}

/// <summary>Config-bindable defaults used to seed the persisted pre-download policy.</summary>
public sealed class PreDownloadOptions
{
    public const int MinCurrentFileThresholdSeconds = 0;
    public const int MaxCurrentFileThresholdSeconds = 3_600;
    public const int MinNextEpisodeThresholdPercent = 1;
    public const int MaxNextEpisodeThresholdPercent = 100;
    public const int MinNextEpisodeReleaseSimilarityThresholdPercent = 0;
    public const int MaxNextEpisodeReleaseSimilarityThresholdPercent = 100;
    public const int MinimumConcurrentDownloads = 1;
    public const int MaximumConcurrentDownloads = 8;

    public bool Enabled { get; set; }
    public bool DownloadCurrentFile { get; set; } = true;
    public int CurrentFileThresholdSeconds { get; set; } = 10;
    public bool DownloadNextEpisode { get; set; } = true;
    public int NextEpisodeThresholdPercent { get; set; } = 75;
    public bool PreferSimilarNextEpisodeRelease { get; set; }
    public int NextEpisodeReleaseSimilarityThresholdPercent { get; set; } = 75;
    public int MaxConcurrentDownloads { get; set; } = 1;

    /// <summary>Workspace root for completed and partial pre-download files.</summary>
    public string CachePath { get; set; } = string.Empty;

    /// <summary>Free-space reserve the background downloader must leave untouched.</summary>
    public long MinimumFreeDiskBytes { get; set; } = 1L * 1024 * 1024 * 1024;
}

/// <summary>When the Core repairs a damaged release instead of (or in addition to) falling back.</summary>
public enum RepairPolicy
{
    /// <summary>Repair only when no healthy sibling release exists (default).</summary>
    WhenNoFallback,

    /// <summary>Always repair the requested release, even when a healthy fallback exists.</summary>
    PreferRepair,
}

/// <summary>Options for the PAR2 repair pipeline. Conservative defaults; all validated.</summary>
public sealed class RepairOptions
{
    public bool Enabled { get; set; } = true;

    public RepairPolicy Policy { get; set; } = RepairPolicy.WhenNoFallback;

    /// <summary>Offer a progressive (repair-while-streaming) capability at resolve time.</summary>
    public bool ProgressiveEnabled { get; set; }

    /// <summary>A progressive offer requires at least this many intact bytes before the first hole.</summary>
    public long ProgressiveMinIntactPrefixBytes { get; set; } = 32L * 1024 * 1024;

    public int MaxConcurrentJobs { get; set; } = 1;

    /// <summary>Concurrent low-priority NNTP fetches a repair job may occupy.</summary>
    public int MaxConnections { get; set; } = 4;

    /// <summary>Workspace + artifact root; empty resolves to &lt;content root&gt;/cache/repair.</summary>
    public string WorkspacePath { get; set; } = string.Empty;

    /// <summary>Total budget for published artifacts (LRU-evicted).</summary>
    public long CacheBudgetBytes { get; set; } = 20L * 1024 * 1024 * 1024;

    /// <summary>Largest single artifact the pipeline will attempt.</summary>
    public long MaxArtifactBytes { get; set; } = 8L * 1024 * 1024 * 1024;

    /// <summary>Repair refuses to start when the workspace volume has less free space.</summary>
    public long MinFreeDiskBytes { get; set; } = 5L * 1024 * 1024 * 1024;

    public int JobTimeoutSeconds { get; set; } = 3_600;

    /// <summary>How long an already-open read blocks at a hole before failing over to the old behavior.</summary>
    public int WaitAtHoleTimeoutSeconds { get; set; } = 90;

    public int ArtifactTtlSeconds { get; set; } = 7 * 24 * 3_600;

    /// <summary>A failed job cannot be retried for this long.</summary>
    public int FailureBackoffSeconds { get; set; } = 900;

    /// <summary>Retained state-transition events per job for debugging.</summary>
    public int MaxJobEvents { get; set; } = 128;

    /// <summary>Finished jobs kept in the in-memory list for the admin UI.</summary>
    public int MaxFinishedJobs { get; set; } = 64;

    /// <summary>Upper bound for a single PAR2 packet accepted from the wire.</summary>
    public long MaxPar2PacketBytes { get; set; } = 256L * 1024 * 1024;

    /// <summary>Upper bound for the PAR2 slice (block) size.</summary>
    public long MaxPar2SliceBytes { get; set; } = 128L * 1024 * 1024;

    /// <summary>Most files accepted in one recovery set.</summary>
    public int MaxPar2Files { get; set; } = 256;

    /// <summary>Largest accepted PAR2 index file.</summary>
    public long MaxPar2IndexBytes { get; set; } = 64L * 1024 * 1024;
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

    /// <summary>Contiguous media segments verified through BODY from the start of every release.</summary>
    public int StartupSampleCount { get; set; } = 64;

    /// <summary>Maximum decoded startup BODY transfers running ahead of the verifier.</summary>
    public int StartupBodyConcurrency { get; set; } = 4;

    public int Concurrency { get; set; } = 20;

    /// <summary>Indeterminate spread-sample ratio at or above which a release is dead.</summary>
    public double DeadMissingRatio { get; set; } = 0.5;
}
