using Streamarr.Core.Media;
using Streamarr.Server.Auth;
using Streamarr.Server.Options;
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

        services.AddControllers();

        // OpenAPI is the cross-interface contract (BRIEF.md §3.1); Swashbuckle serves it.
        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen();

        services.Configure<StreamarrOptions>(builder.Configuration.GetSection(StreamarrOptions.SectionName));

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
