using System.Collections.Concurrent;
using System.Net;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// Placeholder supervisor until the helper process management lands: every enabled tunnel is <c>down</c> with
/// <c>lastError</c> "helper not started yet", disabled tunnels are <c>disabled</c>. Routed connections therefore fail
/// closed, which is the contract the real supervisor keeps.
/// </summary>
public sealed class NotStartedTunnelSupervisor(TunnelConfigService tunnels, TimeProvider time) : ITunnelSupervisor
{
    public const string NotStartedError = "helper not started yet";

    private readonly ConcurrentDictionary<string, TunnelStatus> _statuses = new(StringComparer.Ordinal);

    public TunnelStatus? GetStatus(string tunnelId)
        => _statuses.TryGetValue(tunnelId, out var status) ? status : null;

    public IReadOnlyDictionary<string, TunnelStatus> Snapshot()
        => new Dictionary<string, TunnelStatus>(_statuses, StringComparer.Ordinal);

    public IPEndPoint? ProxyEndpoint(string tunnelId) => null;

    public async Task ReloadAsync(CancellationToken ct)
    {
        var rows = await tunnels.ListAsync(ct);
        var now = time.GetUtcNow();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            seen.Add(row.Id);
            var state = row.Enabled ? TunnelStates.Down : TunnelStates.Disabled;
            _statuses.AddOrUpdate(
                row.Id,
                _ => Status(state, now),
                (_, existing) => existing.State == state ? existing : Status(state, now));
        }
        foreach (var stale in _statuses.Keys.Where(id => !seen.Contains(id)).ToList())
            _statuses.TryRemove(stale, out _);
    }

    public async Task<TunnelTestResult> TestAsync(string tunnelId, CancellationToken ct)
    {
        await ReloadAsync(ct);
        var status = GetStatus(tunnelId) ?? Status(TunnelStates.Down, time.GetUtcNow());
        return new TunnelTestResult
        {
            Success = false,
            HandshakeOk = false,
            State = status.State,
            Error = status.State == TunnelStates.Disabled ? "The tunnel is disabled." : status.LastError ?? NotStartedError,
        };
    }

    private static TunnelStatus Status(string state, DateTimeOffset since) => new()
    {
        State = state,
        Since = since,
        LastError = state == TunnelStates.Disabled ? null : NotStartedError,
    };
}

/// <summary>Loads the stored tunnels into the supervisor when the server starts.</summary>
public sealed class TunnelSupervisorHost(ITunnelSupervisor supervisor, ILogger<TunnelSupervisorHost> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await supervisor.ReloadAsync(cancellationToken);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogError(e, "Tunnel supervisor failed to load the stored tunnels");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
