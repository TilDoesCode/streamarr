using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp.Pooling;

namespace Streamarr.Server.Services;

/// <summary>Warms authenticated primary-provider connections without delaying server readiness.</summary>
public sealed class NntpConnectionWarmupService(
    MultiProviderNntpClient client,
    IOptions<StreamarrOptions> options,
    ILogger<NntpConnectionWarmupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var count = EffectiveWarmupCount(options.Value);
        if (count <= 0)
            return;

        await Parallel.ForEachAsync(
            client.Providers.Where(provider => provider.ProviderType == UsenetProviderType.Pooled),
            stoppingToken,
            async (provider, token) =>
            {
                try
                {
                    await provider.WarmAsync(count, token);
                    logger.LogInformation(
                        "Warmed {Count} authenticated NNTP connection(s) for provider {Provider}",
                        provider.IdleConnections,
                        provider.ProviderName);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    // Normal host shutdown.
                }
                catch (Exception exception)
                {
                    // Readiness and later lazy connection creation remain available.
                    logger.LogWarning(exception, "NNTP connection warmup failed for provider {Provider}", provider.ProviderName);
                }
            });
    }

    internal static int EffectiveWarmupCount(StreamarrOptions options)
        => Math.Min(Math.Max(0, options.ConnectionWarmupCount), Math.Max(1, options.ConnectionBudget));
}
