using Streamarr.Server.Services;

namespace Microsoft.Extensions.DependencyInjection;

internal static class JellyfinLogServiceCollectionExtensions
{
    /// <summary>
    /// Registers the optional Jellyfin server-log source. Calling this does not make
    /// a remote request; retrieval remains lazy until a consumer asks for a snapshot.
    /// </summary>
    public static IServiceCollection AddJellyfinLogSource(this IServiceCollection services)
    {
        services.AddOptions<Streamarr.Server.Logging.JellyfinLogOptions>()
            .BindConfiguration(Streamarr.Server.Logging.JellyfinLogOptions.ConfigurationSection);
        services.AddHttpClient(Streamarr.Server.Logging.JellyfinLogSource.HttpClientName, client =>
            {
                // The source owns one hard timeout across both requests.
                client.Timeout = Timeout.InfiniteTimeSpan;
            })
            .ConfigurePrimaryHttpMessageHandler(OutboundHttpHandlerFactory.CreateDirect)
            // Request URLs and headers must never enter Microsoft.Extensions.Http logs.
            .RemoveAllLoggers();
        services.AddSingleton<
            Streamarr.Server.Logging.IJellyfinLogSource,
            Streamarr.Server.Logging.JellyfinLogSource>();
        return services;
    }
}
