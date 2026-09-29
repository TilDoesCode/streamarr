using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;
using Streamarr.Server.Modules;
using Streamarr.Server.Options;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Catalog;
using Streamarr.Server.Viewers.Email;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers;

public static class ViewersServiceCollectionExtensions
{
    /// <summary>Registers the optional viewer-account and watch-state module (off until enabled in its settings).</summary>
    public static IServiceCollection AddStreamarrViewers(this IServiceCollection services)
    {
        services.AddSingleton<ViewerSettingsService>();
        services.AddSingleton<ViewerModule>();
        services.AddSingleton<IStreamarrModule>(sp => sp.GetRequiredService<ViewerModule>());
        services.AddSingleton<ViewerMailOutbox>();
        services.AddSingleton<ViewerMailer>();
        services.AddHostedService(sp => sp.GetRequiredService<ViewerMailer>());
        services.AddSingleton<ViewerCodeService>();
        services.AddSingleton<ViewerSessionService>();
        services.AddSingleton<ViewerAccountService>();
        services.AddSingleton<ViewerTwoFactorService>();
        services.AddSingleton<ViewerLoginService>();
        services.AddSingleton<WatchStateService>();
        services.AddSingleton<NextUpService>();
        services.AddSingleton<ViewerContentPolicy>();
        services.AddSingleton<ViewerVersionCache>();
        services.AddSingleton<PlaybackPredictor>();
        services.AddSingleton<ViewerCatalogService>();

        services.AddAuthentication()
            .AddScheme<AuthenticationSchemeOptions, ViewerAuthenticationHandler>(ViewerAuth.Scheme, _ => { });
        services.AddAuthorization(o => o.AddPolicy(ViewerAuth.Policy, p => p
            .AddAuthenticationSchemes(ViewerAuth.Scheme)
            .RequireAuthenticatedUser()
            .RequireRole(ViewerAuth.Role)
            .RequireClaim(ViewerAuth.AccountTypeClaim, ViewerAuth.AccountType)));
        services.AddRateLimiter(o => o.AddPolicy(ViewerAuth.RateLimitPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = Math.Clamp(context.RequestServices.GetRequiredService<IOptions<StreamarrOptions>>().Value.ViewerAuthAttemptsPerMinute, 1, 1_000),
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true,
            })));
        return services;
    }
}

public sealed class ViewerModule(ViewerSettingsService settings) : IStreamarrModule
{
    public string Id => ViewerAuth.ModuleId;

    public async ValueTask<bool> IsEnabledAsync(CancellationToken ct) => (await settings.GetAsync(ct)).Enabled;
}
