namespace Streamarr.Server.Transcoding;

public static class TranscodingServiceCollectionExtensions
{
    /// <summary>Registers the standalone transcoding path; it depends on the stream path only through its public HTTP endpoint.</summary>
    public static IServiceCollection AddStreamarrTranscoding(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<TranscodingOptions>().Bind(configuration.GetSection(TranscodingOptions.SectionName));
        services.AddSingleton<IProcessRunner, ProcessRunner>();
        services.AddSingleton<TranscodingWorkspace>();
        services.AddSingleton<TranscodingSettingsService>();
        services.AddSingleton<IGpuDeviceEnumerator>(sp => new GpuDeviceEnumerator(sp.GetRequiredService<IProcessRunner>()));
        services.AddSingleton<FfmpegCapabilityProbe>();
        services.AddSingleton<FfmpegCapabilityService>();
        services.AddSingleton<SourceMediaProber>();
        services.AddHttpClient(KeyframeIndexService.HttpClientName, client =>
        {
            client.Timeout = TimeSpan.FromSeconds(30);
            client.DefaultRequestHeaders.UserAgent.ParseAdd(FfmpegArgumentBuilder.UserAgent);
        });
        services.AddSingleton<KeyframeIndexService>();
        services.AddSingleton<TranscodingSampleLibrary>();
        services.AddSingleton<TranscodeSourceResolver>();
        services.AddSingleton<HlsDeliveryIssues>();
        services.AddSingleton<HlsDeliveryIssueFilter>();
        services.AddSingleton<TranscodeSessionManager>();
        services.AddHostedService(sp => sp.GetRequiredService<TranscodeSessionManager>());
        services.AddSingleton<TranscodingBenchmarkService>();
        services.AddHostedService<TranscodingStartup>();
        return services;
    }
}

/// <summary>Detects capabilities right at startup so neither the first UI visit nor the first transcode waits for the self-tests.</summary>
internal sealed class TranscodingStartup(
    TranscodingSettingsService settings,
    FfmpegCapabilityService capabilities,
    ILogger<TranscodingStartup> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var current = await settings.GetAsync(stoppingToken);
            if (current.Enabled)
                await capabilities.RefreshAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Transcoding startup warm-up failed");
        }
    }
}
