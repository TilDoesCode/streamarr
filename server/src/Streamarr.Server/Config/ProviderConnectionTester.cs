using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Config;

/// <summary>Outcome of a provider connectivity test (BRIEF §6.2 /config/providers/{id}/test).</summary>
public sealed record ProviderTestResult
{
    /// <summary>True when at least one authenticated connection was established.</summary>
    public required bool Success { get; init; }

    /// <summary>How many simultaneous authenticated connections we could open (≤ MaxConnections).</summary>
    public required int AchievableConnections { get; init; }

    public required int RequestedConnections { get; init; }
    public string? Error { get; init; }
}

/// <summary>
/// Tests a Usenet provider by opening real NNTP connections and running
/// connect + AUTHINFO, reporting how many simultaneous authenticated connections are
/// achievable (BRIEF §6.2). The connection factory is injectable for tests.
/// </summary>
public sealed class ProviderConnectionTester(Func<INntpClient>? connectionFactory = null)
{
    private readonly Func<INntpClient> _connectionFactory = connectionFactory ?? (() => new SingleConnectionNntpClient());

    /// <summary>Per-connection connect+auth timeout.</summary>
    public TimeSpan PerConnectionTimeout { get; init; } = TimeSpan.FromSeconds(15);

    public async Task<ProviderTestResult> TestAsync(UsenetProvider provider, CancellationToken ct)
    {
        var requested = Math.Clamp(provider.MaxConnections, 1, 100);
        using var concurrency = new SemaphoreSlim(10, 10);

        // Probe the requested capacity with a bounded fan-out so an admin typo cannot
        // create hundreds of simultaneous outbound handshakes.
        var probes = Enumerable.Range(0, requested)
            .Select(async _ =>
            {
                await concurrency.WaitAsync(ct);
                try
                {
                    return await TryOneAsync(provider, ct);
                }
                finally
                {
                    concurrency.Release();
                }
            })
            .ToArray();

        var outcomes = await Task.WhenAll(probes);
        var achievable = outcomes.Count(o => o.Ok);
        var firstError = outcomes.FirstOrDefault(o => !o.Ok).Error;

        return new ProviderTestResult
        {
            Success = achievable > 0,
            AchievableConnections = achievable,
            RequestedConnections = requested,
            Error = achievable > 0 ? null : firstError,
        };
    }

    /// <summary>A single connect + AUTHINFO reachability probe (used by /health).</summary>
    public async Task<(bool Ok, string? Error)> ProbeAsync(UsenetProvider provider, CancellationToken ct)
        => await TryOneAsync(provider, ct);

    private async Task<(bool Ok, string? Error)> TryOneAsync(UsenetProvider provider, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(PerConnectionTimeout);

        var client = _connectionFactory();
        try
        {
            await client.ConnectAsync(provider.Host, provider.Port, provider.UseSsl, timeoutCts.Token);
            if (!string.IsNullOrEmpty(provider.Username))
            {
                var auth = await client.AuthenticateAsync(provider.Username, provider.Password, timeoutCts.Token);
                if (!auth.Success)
                    return (false, $"authentication failed (NNTP {auth.ResponseCode})");
            }

            return (true, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return (false, "cancelled");
        }
        catch (Exception e)
        {
            return (false, e.Message);
        }
        finally
        {
            client.Dispose();
        }
    }
}
