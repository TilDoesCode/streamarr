using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Bootstrap;
using Streamarr.Plugin.Library;
using Streamarr.Plugin.MediaSources;
using Streamarr.Plugin.Playback;
using Streamarr.Plugin.ScheduledTasks;

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
        });

        // Shared singleton caches / lookup tables.
        serviceCollection.AddSingleton<EphemeralReleaseStore>();
        serviceCollection.AddSingleton<PlaybackSessionTracker>();

        // Adapters (stateless).
        serviceCollection.AddSingleton<EphemeralLibraryService>();
        serviceCollection.AddSingleton<PinnedWorkBootstrapper>();

        // The lazy media-source provider Jellyfin discovers via DI.
        serviceCollection.AddSingleton<IMediaSourceProvider, StreamarrMediaSourceProvider>();

        // The bootstrap scheduled task ("sync one pinned work").
        serviceCollection.AddSingleton<IScheduledTask, SyncPinnedWorkTask>();

        // Playback-event bridge (subscribes to ISessionManager on startup).
        serviceCollection.AddHostedService<PlaybackEventEntryPoint>();
    }
}
