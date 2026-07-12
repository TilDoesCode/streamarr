using System.IO;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Core.Search;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Auth;
using Streamarr.Server.Config;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Security;
using Streamarr.Server.Services;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server;

/// <summary>
/// Single place that composes the Core Server — used by Program.cs and by
/// integration tests that need the real server on a real (Kestrel) port.
/// </summary>
public static class StreamarrServerBootstrap
{
    public static WebApplicationBuilder AddStreamarrServer(this WebApplicationBuilder builder)
    {
        var services = builder.Services;

        // explicit application part so controllers are found when the server is
        // composed from a test host (entry-assembly discovery misses them there)
        services.AddControllers()
            .AddApplicationPart(typeof(StreamarrServerBootstrap).Assembly);

        // OpenAPI is the cross-interface contract (BRIEF.md §3.1); Swashbuckle serves it.
        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen();

        services.Configure<StreamarrOptions>(builder.Configuration.GetSection(StreamarrOptions.SectionName));

        // --- persistence + secret protection (BRIEF §4, §6.3) ---------------------------
        // Connection string + key-ring path resolve lazily from the bound options so
        // WebApplicationFactory / test config overrides (applied only at Build) win.
        services.AddDbContextFactory<StreamarrDbContext>((sp, o) =>
        {
            var opts = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value;
            var env = sp.GetRequiredService<IHostEnvironment>();
            var cs = string.IsNullOrWhiteSpace(opts.ConnectionString)
                ? $"Data Source={Path.Combine(env.ContentRootPath, "streamarr.db")}"
                : opts.ConnectionString;
            o.UseSqlite(cs);
        });

        services.AddDataProtection().SetApplicationName("Streamarr");
        // Defer the key-ring location the same way (see StreamarrKeyRingConfiguration).
        services.AddSingleton<Microsoft.Extensions.Options.IConfigureOptions<Microsoft.AspNetCore.DataProtection.KeyManagement.KeyManagementOptions>, StreamarrKeyRingConfiguration>();
        services.AddSingleton<ISecretProtector, SecretProtector>();

        // Config services (SQLite-backed source of truth, CRUD'd by the Management UI).
        services.AddSingleton<IndexerConfigService>();
        services.AddSingleton<ProviderConfigService>();
        services.AddSingleton<ProfileConfigService>();
        services.AddSingleton<GeneralConfigService>();
        services.AddSingleton<WatchEventService>();
        services.AddSingleton<ApiKeyService>();
        services.AddSingleton<IndexerCapsTester>();
        services.AddSingleton(_ => new ProviderConnectionTester());
        services.AddSingleton<StreamarrDbInitializer>();

        // One pooled client per configured provider, fanned out in priority order …
        services.AddSingleton<MultiProviderNntpClient>(sp =>
        {
            var options = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<StreamarrOptions>>().Value;
            return UsenetStreamingClient.Create(
                options.Providers.Select(p => p.ToProvider()),
                sp.GetRequiredService<ILoggerFactory>());
        });

        // … wrapped in the global NNTP connection budget shared across all sessions.
        services.AddSingleton<INntpClient>(sp =>
        {
            var options = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<StreamarrOptions>>().Value;
            return new GatedNntpClient(
                sp.GetRequiredService<MultiProviderNntpClient>(),
                new SemaphoreNntpGate(Math.Max(1, options.ConnectionBudget)),
                disposeInner: true);
        });

        // Newznab indexer fan-out (BRIEF §6.1 module 1): config store seeded from
        // options, per-indexer rate limiting, ~60s search cache, concurrent fan-out.
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IIndexerConfigStore>(sp => sp.GetRequiredService<IndexerConfigService>());
        services.AddSingleton(sp => sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search);
        services.AddSingleton(sp =>
        {
            var search = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search;
            return new SearchCache(search.CacheTtl, sp.GetRequiredService<TimeProvider>());
        });
        services.AddSingleton<IIndexerRateLimiter>(sp =>
        {
            var search = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search;
            return new IndexerRateLimiter(search.RateLimitInterval, sp.GetRequiredService<TimeProvider>());
        });
        services.AddHttpClient<INewznabClient, NewznabClient>();
        services.AddSingleton<IndexerSearchService>();

        // TMDB matcher (BRIEF §6.1 module 3): a typed HttpClient wrapped in an
        // aggressive caching decorator. With no API key the client no-ops to null so
        // search still works before the owner supplies a key.
        services.AddSingleton(sp => sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Tmdb);
        services.AddHttpClient<TmdbClient>();
        services.AddSingleton<ITmdbClient>(sp =>
        {
            var tmdbOptions = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Tmdb;
            return new CachingTmdbClient(
                sp.GetRequiredService<TmdbClient>(),
                tmdbOptions.CacheTtl,
                sp.GetRequiredService<TimeProvider>());
        });

        // Parse → reject → rank → aggregate to works (BRIEF §7).
        services.AddSingleton(new ReleaseEvaluator());
        services.AddSingleton<IProfileProvider>(sp => sp.GetRequiredService<ProfileConfigService>());
        services.AddSingleton<WorkAggregator>();
        services.AddSingleton<SearchService>();

        services.AddSingleton<IReleaseStore, InMemoryReleaseStore>();
        services.AddSingleton<SessionManager>();
        services.AddHostedService(sp => sp.GetRequiredService<SessionManager>());
        services.AddSingleton<HealthChecker>();
        services.AddSingleton<MediaFileMaterializer>();
        services.AddSingleton<FfprobeClient>();
        services.AddSingleton<ResolveService>();
        services.AddHttpClient<NzbFetcher>();

        return builder;
    }

    public static WebApplication UseStreamarrServer(this WebApplication app)
    {
        // Apply migrations, seed from options on first run, and overlay the persisted
        // config onto the running options — before any request or hosted service resolves
        // a config-derived singleton (BRIEF §6.3).
        using (var scope = app.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<StreamarrDbInitializer>().Initialize();
        }

        if (app.Environment.IsDevelopment())
        {
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseMiddleware<ApiKeyAuthMiddleware>();
        app.MapControllers();

        return app;
    }
}
