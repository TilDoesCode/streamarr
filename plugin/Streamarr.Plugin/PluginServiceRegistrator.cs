using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Bootstrap;
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
                client.Timeout = TimeSpan.FromSeconds(30);
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

        // Shared singleton caches / lookup tables.
        serviceCollection.AddSingleton<EphemeralReleaseStore>();
        serviceCollection.AddSingleton<PlaybackSessionTracker>();
        serviceCollection.AddSingleton<PlaybackEventDispatcher>();
        serviceCollection.AddSingleton<MediaSourceOfferStore>();
        serviceCollection.AddSingleton<StreamarrMediaSourceProjection>();
        serviceCollection.AddSingleton<HierarchyLoadCoordinator>();
        serviceCollection.AddHttpContextAccessor();

        // Adapters (stateless).
        serviceCollection.AddSingleton<EphemeralLibraryService>();
        serviceCollection.AddSingleton<PinnedWorkBootstrapper>();

        // The lazy media-source provider Jellyfin discovers via DI.
        serviceCollection.AddSingleton<IMediaSourceProvider, StreamarrMediaSourceProvider>();

        // Scheduled tasks: the M5 pinned-work bootstrap and the M6 TTL cleanup (BRIEF §8.5).
        serviceCollection.AddSingleton<IScheduledTask, SyncPinnedWorkTask>();
        serviceCollection.AddSingleton<IScheduledTask, EphemeralCleanupTask>();

        // Playback-event bridge (subscribes to ISessionManager on startup).
        serviceCollection.AddHostedService<PlaybackEventEntryPoint>();

        // Search interception (BRIEF §8.2). Registering an IAsyncActionFilter into MvcOptions is
        // the plugin-side mechanism for augmenting Jellyfin's /Items + /Search/Hints responses
        // (the meilisearch reference plugs into search a different way — via ISearchProvider — but
        // an action filter is what BRIEF §8.2 mandates so the raw QueryResult/hints can be mutated).
        // The filter itself is behind a config toggle and fully try/catch-guarded; this registration
        // is inert until InterceptionEnabled is set. Its ctor deps resolve from DI per request.
        serviceCollection.Configure<MvcOptions>(options =>
            options.Filters.Add<StreamarrSearchActionFilter>());
    }
}
