using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Tmdb;
using Streamarr.Server;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld;

/// <summary>Wires the real Core Server to the mock Usenet and the canned indexer/TMDB (shared by Program and tests).</summary>
public static class DevWorldHost
{
    public const string NntpProviderName = "devworld-nntp";

    public static MockNntpServer CreateNntp(PublicationStore store)
    {
        var nntp = new MockNntpServer { RequireAuth = true, ArticleSource = store };
        foreach (var id in store.StatDisconnectIds)
            nntp.StatDisconnects[id] = 0;
        return nntp;
    }

    public static WebApplication Build(
        DevWorldOptions options, WorldPlan plan, PublicationStore store, MockNntpServer nntp, DevWorldState state, string[] args)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
            Args = args,
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.WebHost.UseUrls(options.BindUrl);
        builder.Logging.SetMinimumLevel(Enum.TryParse<LogLevel>(options.LogLevel, true, out var level) ? level : LogLevel.Warning);

        string State(string name) => Path.Combine(options.StateDir, name);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Serilog:MinimumLevel:Default"] = options.LogLevel,
            ["Streamarr:ApiKey"] = WorldSeeder.ApiKey,
            ["Streamarr:Admin:Username"] = WorldSeeder.AdminUsername,
            ["Streamarr:Admin:Password"] = WorldSeeder.AdminPassword,
            ["Streamarr:LoginAttemptsPerMinute"] = "120",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "300",
            ["Streamarr:ConnectionString"] = $"Data Source={State("streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = State("keys"),
            ["Streamarr:NzbCachePath"] = State("nzb-cache"),
            ["Streamarr:ConnectionBudget"] = "12",
            ["Streamarr:ConnectionWarmupCount"] = "2",
            ["Streamarr:SegmentCacheSizeMb"] = "64",
            ["Streamarr:EphemeralCacheSizeMb"] = "4096",
            // Short so the dead-release fallback can be exercised repeatedly without a restart.
            ["Streamarr:HealthCacheTtlSeconds"] = "120",
            ["Streamarr:Tmdb:ApiKey"] = "devworld-fixture",
            ["Streamarr:AllowLocalNzbFiles"] = "true",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Indexers:0:Id"] = DevWorldIds.IndexerId,
            ["Streamarr:Indexers:0:Name"] = "Dev World",
            ["Streamarr:Indexers:0:BaseUrl"] = "http://indexer.devworld.invalid/api",
            ["Streamarr:Indexers:0:ApiKey"] = "devworld-indexer-key",
            ["Streamarr:Indexers:0:Categories:0"] = "2000",
            ["Streamarr:Indexers:0:Categories:1"] = "5000",
            ["Streamarr:Providers:0:Name"] = NntpProviderName,
            ["Streamarr:Providers:0:Host"] = nntp.Host,
            ["Streamarr:Providers:0:Port"] = nntp.Port.ToString(),
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = nntp.Username,
            ["Streamarr:Providers:0:Password"] = nntp.Password,
            ["Streamarr:Providers:0:MaxConnections"] = "12",
            ["Streamarr:PreDownload:CachePath"] = State("predownload"),
            ["Streamarr:Repair:WorkspacePath"] = State("repair"),
            ["Streamarr:Transcoding:WorkspacePath"] = State("transcode"),
            ["Streamarr:Transcoding:SamplesPath"] = State("transcode-samples"),
            ["Streamarr:Transcoding:LocalSourceBaseUrl"] = options.LocalUrl,
        });

        builder.AddStreamarrServer();
        builder.Services.RemoveAll<INewznabClient>();
        builder.Services.AddSingleton<INewznabClient>(new CannedNewznabClient(store.Releases, DateTimeOffset.UtcNow));
        builder.Services.RemoveAll<ITmdbClient>();
        builder.Services.AddSingleton<ITmdbClient>(new CannedTmdbClient(plan.Catalog));

        var app = builder.Build();
        app.UseDevWorldCors();
        app.UseStreamarrServer();
        app.MapDevWorld(state);
        return app;
    }
}
