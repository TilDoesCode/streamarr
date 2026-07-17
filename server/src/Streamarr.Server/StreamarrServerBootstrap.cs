using System.IO;
using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi.Models;
using Serilog;
using Serilog.Events;
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

        builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 1024 * 1024);

        // Structured logging (BRIEF §10-M7 observability). Serilog replaces the default
        // logger; it reads any "Serilog" config section, enriches with request context,
        // and writes structured lines to the console. Request logging is added in
        // UseStreamarrServer. Honors the host's existing minimum level in tests.
        builder.Host.UseSerilog((context, loggerConfig) => loggerConfig
            .ReadFrom.Configuration(context.Configuration)
            .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
            // Typed HttpClient information logs contain full query strings. Newznab
            // and TMDB authenticate in those query strings, so never emit these URIs.
            .MinimumLevel.Override("System.Net.Http.HttpClient", LogEventLevel.Warning)
            .WriteTo.Console(
                outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}"));

        // explicit application part so controllers are found when the server is
        // composed from a test host (entry-assembly discovery misses them there)
        services.AddControllers()
            .AddApplicationPart(typeof(StreamarrServerBootstrap).Assembly);

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.OnRejected = async (context, token) =>
            {
                context.HttpContext.Response.ContentType = "application/json";
                context.HttpContext.Response.Headers.RetryAfter = "60";
                await context.HttpContext.Response.WriteAsJsonAsync(
                    Contracts.ErrorResponse.Of("rate_limited", "Too many requests; retry later."), token);
            };
            o.AddPolicy("login", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = Math.Clamp(
                        context.RequestServices.GetRequiredService<IOptions<StreamarrOptions>>()
                            .Value.LoginAttemptsPerMinute,
                        1,
                        1_000),
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                    AutoReplenishment = true,
                }));
            o.AddPolicy("health", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 30,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                    AutoReplenishment = true,
                }));
        });

        // Honor one explicitly trusted reverse-proxy hop. The framework's loopback
        // defaults stay in place; deployments may add exact proxy addresses without
        // accepting spoofable forwarded headers from arbitrary clients.
        services.AddOptions<ForwardedHeadersOptions>()
            .Configure<IOptions<StreamarrOptions>>((forwarded, configured) =>
            {
                forwarded.ForwardedHeaders =
                    ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
                forwarded.ForwardLimit = 1;
                foreach (var value in configured.Value.TrustedProxies)
                {
                    forwarded.KnownProxies.Add(IPAddress.Parse(value));
                }
            });

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
            o.OperationFilter<AllowAnonymousOperationFilter>();

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
            // Every endpoint without an explicit attribute still requires authentication.
            // Stream/close explicitly opt out because their unguessable path capability is the
            // narrowly-scoped credential and no ambient admin/machine secret belongs in media IO.
            o.FallbackPolicy = authenticated;
            o.DefaultPolicy = authenticated;
            o.AddPolicy(AuthRoles.AdminPolicy, p => p
                .AddAuthenticationSchemes(AuthRoles.Scheme)
                .RequireAuthenticatedUser()
                .RequireRole(AuthRoles.Admin));
        });

        services.AddSingleton<IValidateOptions<StreamarrOptions>, StreamarrOptionsValidator>();
        services.AddOptions<StreamarrOptions>()
            .Bind(builder.Configuration.GetSection(StreamarrOptions.SectionName))
            .Configure(options =>
            {
                // This deliberate alias is the public deployment contract. It is not
                // one of HttpClient's ambient proxy variables and affects only the
                // handlers wired to IndexerProxy below.
                var indexerProxy = builder.Configuration[StreamarrOptions.IndexerProxyEnvironmentVariable];
                if (indexerProxy is not null)
                    options.IndexerProxy = indexerProxy;
            })
            .ValidateOnStart();

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
        services.AddSingleton(_ => new ProviderSpeedTester());
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

        // Observability (BRIEF §10-M7): process-wide metrics behind /api/v1/metrics, and
        // the seam the indexer fan-out reports per-indexer latency into.
        services.AddSingleton<StreamarrMetrics>();
        services.AddSingleton<IIndexerLatencyRecorder>(sp => sp.GetRequiredService<StreamarrMetrics>());

        // Newznab indexer fan-out (BRIEF §6.1 module 1): config store seeded from
        // options, per-indexer rate limiting, ~60s search cache, concurrent fan-out.
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IIndexerConfigStore>(sp => sp.GetRequiredService<IndexerConfigService>());
        services.AddSingleton(sp => sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search);
        services.AddSingleton(sp =>
        {
            var search = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search;
            return new SearchCache(
                search.CacheTtl,
                sp.GetRequiredService<TimeProvider>(),
                sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.SearchCacheMaxEntries);
        });
        services.AddSingleton<IIndexerRateLimiter>(sp =>
        {
            var search = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Search;
            return new IndexerRateLimiter(search.RateLimitInterval, sp.GetRequiredService<TimeProvider>());
        });
        services.AddHttpClient<INewznabClient, NewznabClient>(client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
        })
            .ConfigurePrimaryHttpMessageHandler(sp => OutboundHttpHandlerFactory.CreateIndexer(
                sp.GetRequiredService<IOptions<StreamarrOptions>>().Value))
            .RemoveAllLoggers();
        services.AddSingleton<IndexerSearchService>();
        services.AddSingleton<SearchConcurrencyGate>();

        // TMDB matcher (BRIEF §6.1 module 3): a typed HttpClient wrapped in an
        // aggressive caching decorator. With no API key the client no-ops to null so
        // search still works before the owner supplies a key.
        services.AddSingleton(sp => sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Tmdb);
        services.AddHttpClient<TmdbClient>()
            .ConfigurePrimaryHttpMessageHandler(OutboundHttpHandlerFactory.CreateDirect)
            .RemoveAllLoggers();
        services.AddSingleton<ITmdbClient>(sp =>
        {
            var tmdbOptions = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.Tmdb;
            return new CachingTmdbClient(
                sp.GetRequiredService<TmdbClient>(),
                tmdbOptions.CacheTtl,
                sp.GetRequiredService<TimeProvider>(),
                sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.TmdbCacheMaxEntries,
                tmdbOptions.MaxConcurrentRequests,
                tmdbOptions.RequestTimeout,
                () => tmdbOptions.CredentialRevision);
        });

        // Parse → reject → rank → aggregate to works (BRIEF §7).
        services.AddSingleton(new ReleaseEvaluator());
        services.AddSingleton<IProfileProvider>(sp => sp.GetRequiredService<ProfileConfigService>());
        services.AddSingleton<WorkAggregator>();
        services.AddSingleton<SearchService>();
        services.AddSingleton<TvCatalogService>();

        // Remembers dead classifications so they feed back into ranking + fallback
        // selection and survive re-searches (BRIEF §10-M7).
        services.AddSingleton<IReleaseHealthCache>(sp =>
        {
            var opts = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value;
            return new ReleaseHealthCache(
                TimeSpan.FromSeconds(Math.Max(0, opts.HealthCacheTtlSeconds)),
                sp.GetRequiredService<TimeProvider>(),
                opts.HealthCacheMaxEntries);
        });

        services.AddSingleton<IReleaseStore>(sp => new InMemoryReleaseStore(
            sp.GetRequiredService<IReleaseHealthCache>(),
            sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.ReleaseStoreMaxEntries));
        services.AddSingleton<SessionManager>();
        services.AddHostedService(sp => sp.GetRequiredService<SessionManager>());
        services.AddSingleton<HealthChecker>();
        services.AddSingleton<Controllers.DeepHealthDiagnostics>();
        services.AddSingleton(sp =>
        {
            var sizeMb = sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.SegmentCacheSizeMb;
            return new Streamarr.Usenet.Streams.SegmentCache(checked((long)sizeMb * 1024 * 1024));
        });
        services.AddSingleton<MediaFileMaterializer>();
        services.AddSingleton<FfprobeClient>();
        services.AddSingleton<ResolveService>();
        services.AddHttpClient<NzbFetcher>(client =>
            {
                client.Timeout = TimeSpan.FromSeconds(60);
            })
            .ConfigurePrimaryHttpMessageHandler(sp => OutboundHttpHandlerFactory.CreateIndexer(
                sp.GetRequiredService<IOptions<StreamarrOptions>>().Value,
                maxConnectionsPerServer: 8))
            .RemoveAllLoggers();

        return builder;
    }

    public static WebApplication UseStreamarrServer(this WebApplication app)
    {
        // One structured summary line per request (method, path, status, elapsed) —
        // BRIEF §10-M7 observability. Cheap and emitted at Information.
        // Request paths can contain 192-bit stream capability tokens. Keep the useful
        // method/status/timing summary without persisting path parameters.
        app.UseSerilogRequestLogging(o =>
        {
            o.MessageTemplate = "HTTP {RequestMethod} {RequestPath} completed {StatusCode} in {Elapsed:0.0000} ms";
            o.IncludeQueryInRequestPath = false;
            o.GetMessageTemplateProperties = (context, elapsed, statusCode, _) =>
            [
                new LogEventProperty("RequestMethod", new ScalarValue(context.Request.Method)),
                new LogEventProperty("RequestPath", new ScalarValue(RedactRequestPath(context.Request.Path))),
                new LogEventProperty("StatusCode", new ScalarValue(statusCode)),
                new LogEventProperty("Elapsed", new ScalarValue(elapsed)),
            ];
        });

        app.UseForwardedHeaders();
        if (!app.Environment.IsDevelopment())
            app.UseHsts();

        app.Use(async (context, next) =>
        {
            var headers = context.Response.Headers;
            headers.XContentTypeOptions = "nosniff";
            headers.XFrameOptions = "DENY";
            headers["Referrer-Policy"] = "no-referrer";
            var scriptPolicy = app.Environment.IsDevelopment()
                ? "script-src 'self' 'unsafe-inline'; "
                : "script-src 'self'; ";
            headers["Content-Security-Policy"] =
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
                "form-action 'self'; " + scriptPolicy + "style-src 'self' 'unsafe-inline'; " +
                "img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; font-src 'self'";
            headers.Append("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
            if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
            {
                headers.CacheControl = "private, no-store, max-age=0";
                headers.Pragma = "no-cache";
                headers.Append("Vary", "Authorization");
                headers.Append("Vary", "Cookie");
            }

            if (context.Request.ContentLength is > 1024 * 1024)
            {
                context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsJsonAsync(
                    Contracts.ErrorResponse.Of("payload_too_large", "API request bodies are limited to 1 MiB."));
                return;
            }
            await next();
        });

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
        // Additional browser-visible origins trusted by the CSRF same-origin check, normalized
        // once at startup. Populated when the SPA is served from a different public URL than the
        // Core Server reconstructs locally (TLS-terminating tunnel / Codecraft forwarded URLs).
        var trustedOrigins = app.Services.GetRequiredService<IOptions<StreamarrOptions>>().Value
            .TrustedOrigins
            .Select(value => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
                ? NormalizeOrigin(uri)
                : null)
            .OfType<string>()
            .ToHashSet(StringComparer.Ordinal);

        app.UseRouting();
        app.UseRateLimiter();
        app.UseAuthentication();
        app.Use(async (context, next) =>
        {
            var unsafeMethod = !HttpMethods.IsGet(context.Request.Method) &&
                               !HttpMethods.IsHead(context.Request.Method) &&
                               !HttpMethods.IsOptions(context.Request.Method) &&
                               !HttpMethods.IsTrace(context.Request.Method);
            var cookieAuthenticated = context.User.HasClaim(
                AdminAuthCookie.MethodClaim,
                AdminAuthCookie.MethodValue);

            if (unsafeMethod && cookieAuthenticated && !HasSameOrigin(context.Request, trustedOrigins))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsJsonAsync(
                    Contracts.ErrorResponse.Of("csrf_rejected", "Cookie-authenticated state changes require a same-origin request."));
                return;
            }

            await next();
        });
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

    internal static string RedactRequestPath(PathString path)
    {
        var value = path.Value ?? string.Empty;
        if (path.StartsWithSegments("/api/v1/stream", StringComparison.OrdinalIgnoreCase))
            return "/api/v1/stream/{capability}";

        if (path.StartsWithSegments("/api/v1/sessions", StringComparison.OrdinalIgnoreCase,
                out var remainder) &&
            remainder.Value?.EndsWith("/close", StringComparison.OrdinalIgnoreCase) == true)
        {
            return "/api/v1/sessions/{capability}/close";
        }

        return value;
    }

    private static bool HasSameOrigin(HttpRequest request, IReadOnlySet<string> trustedOrigins)
    {
        if (!Uri.TryCreate(request.Headers.Origin.ToString(), UriKind.Absolute, out var origin))
            return false;
        var sameOrigin =
            string.Equals(origin.Scheme, request.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(origin.IdnHost, request.Host.Host, StringComparison.OrdinalIgnoreCase) &&
            origin.Port == (request.Host.Port ?? (request.IsHttps ? 443 : 80));
        // The exact-match path above assumes the browser and Kestrel see the same origin. When
        // the UI is served through a forwarding proxy that terminates TLS or rewrites the host,
        // fall back to an operator-configured allowlist of trusted browser-visible origins.
        return sameOrigin || trustedOrigins.Contains(NormalizeOrigin(origin));
    }

    /// <summary>Canonical <c>scheme://host:port</c> form (lowercased, explicit port) for origin comparison.</summary>
    private static string NormalizeOrigin(Uri uri)
        => $"{uri.Scheme.ToLowerInvariant()}://{uri.IdnHost.ToLowerInvariant()}:{uri.Port}";
}
