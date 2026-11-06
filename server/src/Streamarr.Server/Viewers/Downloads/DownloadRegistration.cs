using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Viewers.Downloads;

public static class DownloadRegistration
{
    public static IServiceCollection AddStreamarrViewerDownloads(this IServiceCollection services)
    {
        services.AddSingleton<ILiveStreamSignal, SessionLiveStreamSignal>();
        services.AddSingleton(sp =>
        {
            var viewerSettings = sp.GetRequiredService<ViewerSettingsService>();
            return new DownloadTransferGovernor(() => viewerSettings.Current.Downloads, sp.GetRequiredService<ILiveStreamSignal>());
        });
        services.AddSingleton(sp =>
        {
            var budget = Math.Max(1, sp.GetRequiredService<IOptions<StreamarrOptions>>().Value.ConnectionBudget);
            var viewerSettings = sp.GetRequiredService<ViewerSettingsService>();
            return new DownloadConnectionGate(
                sp.GetRequiredService<SemaphoreNntpGate>(),
                () => Math.Max(1, budget * viewerSettings.Current.Downloads.ConnectionSharePercent / 100));
        });
        services.AddSingleton<DownloadNntpClient>();
        services.AddSingleton<IDownloadFileSource, SessionDownloadFileSource>();
        services.AddSingleton<ViewerDownloadService>();
        services.AddHostedService(sp => sp.GetRequiredService<ViewerDownloadService>());
        services.AddSingleton<IViewerAccessListener>(sp => sp.GetRequiredService<ViewerDownloadService>());
        services.AddSingleton<DownloadAccounting>();
        services.AddHostedService(sp => sp.GetRequiredService<DownloadAccounting>());
        services.AddSingleton<ViewerDownloadFileService>();
        return services;
    }
}
