namespace Streamarr.DevWorld;

/// <summary>Environment contract of the harness (see README.md).</summary>
public sealed record DevWorldOptions
{
    public int Port { get; init; } = 39300;
    public string Host { get; init; } = "0.0.0.0";
    public required string CacheDir { get; init; }
    public required string StateDir { get; init; }
    public required string CatalogPath { get; init; }
    public int GenerateJobs { get; init; } = 2;
    public string LogLevel { get; init; } = "Warning";
    public bool WritePrimaryManifest { get; init; }
    public string? SnapshotInfoPath { get; init; }
    public bool GenerateOnly { get; init; }

    /// <summary>Resolve every release at boot and fail unless each one resolves as its fixture health (publish's boot check).</summary>
    public bool CheckReleases { get; init; }

    /// <summary>Keep the state directory (database, keys, viewer accounts, watch state) of the previous run on this port.</summary>
    public bool KeepData { get; init; }

    public string MediaDir => Path.Combine(CacheDir, "media");
    public string BindUrl => $"http://{UrlHost(Host)}:{Port}";
    public string LocalUrl => $"http://{(BindsAllInterfaces || Host == "localhost" ? "127.0.0.1" : UrlHost(Host))}:{Port}";
    public bool BindsAllInterfaces => Host is "0.0.0.0" or "::" or "[::]" or "*" or "+";

    /// <summary>10.0.2.2 is the emulator's alias for the host loopback, so a specific LAN bind needs the LAN URL.</summary>
    public string AndroidEmulatorUrl => BindsAllInterfaces || Host is "127.0.0.1" or "localhost" ? $"http://10.0.2.2:{Port}" : LocalUrl;

    private static string UrlHost(string host) => host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;

    public static DevWorldOptions FromEnvironment(string[] args)
    {
        static string? Env(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : null;

        var port = int.TryParse(Env("DEVWORLD_PORT"), out var p) ? p : 39300;
        var cacheDir = Path.GetFullPath(Env("DEVWORLD_CACHE_DIR") ?? DefaultCacheDir());
        return new DevWorldOptions
        {
            Port = port,
            Host = Env("DEVWORLD_HOST") ?? "0.0.0.0",
            CacheDir = cacheDir,
            StateDir = Path.GetFullPath(Env("DEVWORLD_STATE_DIR") ?? Path.Combine(cacheDir, $"state-{port}")),
            CatalogPath = Path.GetFullPath(Env("DEVWORLD_CATALOG") ?? Path.Combine(AppContext.BaseDirectory, "fixtures", "catalog.json")),
            GenerateJobs = int.TryParse(Env("DEVWORLD_GEN_JOBS"), out var jobs) ? Math.Clamp(jobs, 1, 8) : 2,
            LogLevel = Env("DEVWORLD_LOG_LEVEL") ?? "Warning",
            WritePrimaryManifest = port == 39300 || Env("DEVWORLD_PRIMARY") == "1",
            SnapshotInfoPath = Env("DEVWORLD_SNAPSHOT_INFO"),
            GenerateOnly = args.Contains("--generate-only"),
            CheckReleases = Env("DEVWORLD_CHECK_RELEASES") == "1",
            KeepData = Env("DEVWORLD_KEEP_DATA") == "1",
        };
    }

    /// <summary>Next to the project when run from the source tree; the shared user cache otherwise.</summary>
    private static string DefaultCacheDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Streamarr.DevWorld.csproj")))
                return Path.Combine(dir.FullName, "cache");
        }

        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "streamarr-devworld", "media-cache");
    }
}
