namespace Streamarr.Server.Viewers.Downloads;

public static class DownloadRegistration
{
    public static IServiceCollection AddStreamarrViewerDownloads(this IServiceCollection services)
    {
        services.AddSingleton<ViewerDownloadService>();
        services.AddSingleton<ViewerDownloadFileService>();
        return services;
    }
}
