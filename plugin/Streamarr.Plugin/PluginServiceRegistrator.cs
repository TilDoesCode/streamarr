using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Bootstrap;
using Streamarr.Plugin.Downloads;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Playback;
using Streamarr.Plugin.ScheduledTasks;
using Streamarr.Plugin.Search;

namespace Streamarr.Plugin;

/// <summary>
/// DI wiring for the plugin (BRIEF §8.1). Registers the typed <see cref="StreamarrApiClient"/>,
/// the <see cref="IMediaSourceProvider"/>, the playback-event bridge, the bootstrap task and
/// the singleton caches. Everything registered here is translation/transport — no domain logic.
/// </summary>
public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // Typed HttpClient over the Core Server API. Base address / auth are read per-call
        // from the live PluginConfiguration, so a short handler lifetime is fine.
        serviceCollection.AddHttpClient<StreamarrApiClient>(client =>
            {
                // Core permits configurable ffprobe runs up to ten minutes, in addition to NZB
                // fetch, health checks, and RAR materialization. A fixed transport timeout made
                // cold playback fail while the same release succeeded once caches were warm.
                // Every caller already supplies a lifecycle/request deadline; keep that as the
                // single source of cancellation instead of imposing a contradictory 30s cap.
                client.Timeout = Timeout.InfiniteTimeSpan;
                client.MaxResponseContentBufferSize = StreamarrApiClient.MaxApiResponseBytes;
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                UseCookies = false,
                MaxConnectionsPerServer = 8,
                ConnectTimeout = TimeSpan.FromSeconds(5),
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            })
            // Core credentials and session capabilities appear in headers/URLs. The typed
            // transport performs its own redacted failure logging, so factory URI logs are off.
            .RemoveAllLoggers();

        serviceCollection.AddHttpClient("StreamarrArtwork", client =>
            {
                client.Timeout = TimeSpan.FromSeconds(15);
                client.MaxResponseContentBufferSize = 20 * 1024 * 1024;
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                UseCookies = false,
                MaxConnectionsPerServer = 4,
                ConnectTimeout = TimeSpan.FromSeconds(5),
                PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            })
            .RemoveAllLoggers();

        // Shared singleton caches / lookup tables.
        serviceCollection.AddSingleton<EphemeralReleaseStore>();
        serviceCollection.AddSingleton<ArtworkBadgeService>();
        serviceCollection.AddSingleton<PlaybackSessionTracker>();
        serviceCollection.AddSingleton<PlaybackEventDispatcher>();
        serviceCollection.AddSingleton<MediaSourceOfferStore>();
        serviceCollection.AddSingleton<StreamarrMediaSourceProjection>();
        serviceCollection.AddSingleton<EphemeralReleaseRefresher>();
        serviceCollection.AddSingleton<LocalReleaseAvailabilityService>();
        serviceCollection.AddSingleton<HierarchyLoadCoordinator>();
        serviceCollection.AddSingleton<HierarchyEnrichmentDispatcher>();
        serviceCollection.AddHttpContextAccessor();

        // Adapters (stateless).
        serviceCollection.AddSingleton<EphemeralLibraryService>();
        serviceCollection.AddSingleton<PinnedWorkBootstrapper>();

        // The lazy media-source provider Jellyfin discovers via DI. Also registered under its
        // concrete type (same singleton instance) so the download action filter below can
        // reuse its admission/fallback/tracking logic exactly instead of duplicating it.
        serviceCollection.AddSingleton<StreamarrMediaSourceProvider>();
        serviceCollection.AddSingleton<IMediaSourceProvider>(sp => sp.GetRequiredService<StreamarrMediaSourceProvider>());

        // Scheduled tasks: the M5 pinned-work bootstrap and the M6 TTL cleanup (BRIEF §8.5).
        serviceCollection.AddSingleton<IScheduledTask, SyncPinnedWorkTask>();
        serviceCollection.AddSingleton<IScheduledTask, EphemeralCleanupTask>();

        // Playback-event bridge (subscribes to ISessionManager on startup).
        serviceCollection.AddHostedService<PlaybackEventEntryPoint>();

        // Bounded repair-status observer: polls token-bound Core repair status for actively
        // played Streamarr sessions and surfaces deduplicated DisplayMessage transitions.
        serviceCollection.AddHostedService<RepairStatusObserver>();

        // Ensures the visible "Streamarr" library placement at startup (Continue Watching /
        // Next Up / Favorites integration).
        serviceCollection.AddHostedService<LibraryIntegrationEntryPoint>();
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<HierarchyEnrichmentDispatcher>());

        // Engagement-gated visibility: search hits stay in the hidden staging root until a user
        // plays/favorites them, at which point the subtree is promoted into the visible library.
        serviceCollection.AddHostedService<EngagementPromotionEntryPoint>();

        // Search interception (BRIEF §8.2). Registering an IAsyncActionFilter into MvcOptions is
        // the plugin-side mechanism for augmenting Jellyfin's /Items + /Search/Hints responses
        // (the meilisearch reference plugs into search a different way — via ISearchProvider — but
        // an action filter is what BRIEF §8.2 mandates so the raw QueryResult/hints can be mutated).
        // The filter itself is behind a config toggle and fully try/catch-guarded; this registration
        // is inert until InterceptionEnabled is set. Its ctor deps resolve from DI per request.
        serviceCollection.Configure<MvcOptions>(options =>
            options.Filters.Add<StreamarrSearchActionFilter>());

        // Swiftfin playback compatibility (docs/jellyfin-compatibility.md): rewrites only
        // Swiftfin's PlaybackInfo requests for Streamarr-owned items so the host opens the
        // Core-backed live stream itself and answers with a remux TranscodingUrl — the one
        // playback path Swiftfin implements for remote non-channel sources. Fail-open and
        // scoped by client + item; every other client keeps its native behavior.
        serviceCollection.Configure<MvcOptions>(options =>
            options.Filters.Add<StreamarrPlaybackCompatibilityFilter>());

        // Client-agnostic file download (docs/jellyfin-compatibility.md): rewrites Jellyfin's
        // built-in GET /Items/{id}/Download for Streamarr-owned items into a full-speed proxy
        // of the Core Server's unpaced download capability. Every native/third-party Jellyfin
        // client that calls the standard download endpoint is covered; every other item's
        // Download falls through to Jellyfin's own PhysicalFile handler untouched.
        serviceCollection.Configure<MvcOptions>(options =>
            options.Filters.Add<StreamarrDownloadActionFilter>());
    }
}
