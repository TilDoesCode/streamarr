using System.IO;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi.Models;
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
        // The spec is frozen at /openapi/v1.json and checked into the repo — the web
        // client and any future client generate from it.
        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen(o =>
        {
            o.SwaggerDoc("v1", new OpenApiInfo
            {
                Title = "Streamarr Core Server API",
                Version = "v1",
                Description = "Interface-agnostic API for Usenet search, resolve, and byte-range streaming (BRIEF §6.2).",
            });

            // Both auth modes arrive as `Authorization: Bearer <token>` (BRIEF §6.4):
            // a machine API key or an admin session JWT. Documented as one bearer scheme.
            var scheme = new OpenApiSecurityScheme
            {
                Name = "Authorization",
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                BearerFormat = "API key or JWT",
                In = ParameterLocation.Header,
                Description = "Machine API key or admin session JWT.",
                Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "bearer" },
            };
            o.AddSecurityDefinition("bearer", scheme);
            o.AddSecurityRequirement(new OpenApiSecurityRequirement { [scheme] = Array.Empty<string>() });

            foreach (var xml in Directory.GetFiles(AppContext.BaseDirectory, "Streamarr.*.xml"))
                o.IncludeXmlComments(xml, includeControllerXmlComments: true);
        });

        // --- two-mode auth (BRIEF §6.4) ------------------------------------------------
        // A single custom scheme resolves a bearer token to either a machine principal
        // (API key) or an admin principal (session JWT); the fallback policy requires an
        // authenticated principal on every endpoint, and AdminPolicy gates /config + /debug.
        services.AddSingleton<UserService>();
        services.AddSingleton<JwtTokenService>();
        services.AddSingleton<AdminBootstrap>();

        services.AddAuthentication(AuthRoles.Scheme)
            .AddScheme<AuthenticationSchemeOptions, StreamarrAuthenticationHandler>(AuthRoles.Scheme, _ => { });

        services.AddAuthorization(o =>
        {
            var authenticated = new AuthorizationPolicyBuilder(AuthRoles.Scheme)
                .RequireAuthenticatedUser()
                .Build();
            // Every endpoint without an explicit attribute still requires authentication
            // (BRIEF §11: auth on every endpoint; /stream never public).
            o.FallbackPolicy = authenticated;
            o.DefaultPolicy = authenticated;
            o.AddPolicy(AuthRoles.AdminPolicy, p => p
                .AddAuthenticationSchemes(AuthRoles.Scheme)
                .RequireAuthenticatedUser()
                .RequireRole(AuthRoles.Admin));
        });

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
            // First-run admin bootstrap (BRIEF §6.4): seed the empty users table so the
            // Management UI has an account to log in with.
            scope.ServiceProvider.GetRequiredService<AdminBootstrap>().EnsureAdminAsync().GetAwaiter().GetResult();
        }

        // The frozen OpenAPI spec is always served (not just in Development) at a stable
        // route — it is the checked-in contract the clients generate from (BRIEF §3.1).
        app.UseSwagger(o => o.RouteTemplate = "openapi/{documentName}.json");
        if (app.Environment.IsDevelopment())
            app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "Streamarr v1"));

        // --- Management SPA, production single-origin path (BRIEF §4) -------------------
        // In development the Vite dev server proxies /api to Kestrel; in production the
        // Core Server itself serves the built SPA from wwwroot as static files, with an
        // SPA fallback so client-side routes (/settings, /login, …) resolve to index.html.
        // Both paths are implemented; this half is inert until wwwroot/index.html exists.
        var webRoot = app.Environment.WebRootPath
            ?? Path.Combine(app.Environment.ContentRootPath, "wwwroot");
        var spaEnabled = File.Exists(Path.Combine(webRoot, "index.html"));
        if (spaEnabled)
        {
            // Static files MUST run before routing, otherwise the SPA fallback endpoint
            // shadows real asset requests (documented ASP.NET ordering gotcha).
            app.UseDefaultFiles();
            app.UseStaticFiles();
        }

        // Explicit routing so the static-files middleware above is guaranteed to run first
        // (minimal hosting would otherwise auto-insert routing at the very top).
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();

        if (spaEnabled)
        {
            // Any GET that is not an API or OpenAPI route and did not match a static file
            // falls through to the SPA shell. Anonymous: the shell (incl. the login page)
            // must load before the user has a token; the API stays auth-gated (BRIEF §6.4).
            app.MapFallbackToFile("{*path:regex(^(?!api/|openapi/).*$)}", "index.html")
                .AllowAnonymous();
        }

        return app;
    }
}
