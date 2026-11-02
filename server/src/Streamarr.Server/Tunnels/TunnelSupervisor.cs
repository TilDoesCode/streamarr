using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Tunnels;

/// <summary>Timings of the supervisor state machine; production values come from <c>Streamarr:Tunnels</c>, tests shorten them.</summary>
public sealed class TunnelSupervisorTimings
{
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan FirstPollDelay { get; init; } = TimeSpan.FromSeconds(1);
    public TimeSpan ReadyTimeout { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan HandshakeTimeout { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan HandshakeStale { get; init; } = TimeSpan.FromMinutes(3);
    public TimeSpan ExitCheckInterval { get; init; } = TimeSpan.FromMinutes(10);
    public TimeSpan RestartBackoffInitial { get; init; } = TimeSpan.FromSeconds(2);
    public TimeSpan RestartBackoffMax { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan StopGrace { get; init; } = TimeSpan.FromSeconds(3);
    public int StatusFailuresBeforeRestart { get; init; } = 3;

    public static TunnelSupervisorTimings FromOptions(TunnelsOptions options) => new()
    {
        PollInterval = TimeSpan.FromSeconds(options.PollIntervalSeconds),
        HandshakeTimeout = TimeSpan.FromSeconds(options.HandshakeTimeoutSeconds),
        HandshakeStale = TimeSpan.FromSeconds(options.HandshakeStaleSeconds),
        ExitCheckInterval = TimeSpan.FromSeconds(options.ExitCheckIntervalSeconds),
    };
}

/// <summary>
/// Runs one <c>streamarr-tunnel</c> helper per enabled tunnel (docs/vpn.md): start at boot and on config change,
/// status polling, <c>starting → connected → degraded/down</c> transitions, restart with exponential backoff, and a
/// graceful stop. Only <c>connected</c> tunnels hand out their SOCKS5 endpoint; everything else fails closed.
/// </summary>
public sealed class TunnelSupervisor(
    TunnelConfigService tunnels,
    ITunnelHelperLauncher launcher,
    TunnelSupervisorTimings timings,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<TunnelSupervisor> logger) : ITunnelSupervisor, IAsyncDisposable
{
    public const string DisabledByOptionsError = "tunnels are switched off (Streamarr:Tunnels:Enabled=false)";
    public const string NoPrivateKeyError = "no private key is stored for this tunnel (lost key ring?)";

    private readonly SemaphoreSlim _reloadLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TunnelRunner> _runners = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, TunnelStatus> _idle = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _names = new(StringComparer.Ordinal);
    private int _disposed;

    public TunnelStatus? GetStatus(string tunnelId)
        => _runners.TryGetValue(tunnelId, out var runner) ? runner.Status
            : _idle.TryGetValue(tunnelId, out var idle) ? idle : null;

    public string? GetName(string tunnelId) => _names.TryGetValue(tunnelId, out var name) ? name : null;

    public IReadOnlyDictionary<string, TunnelStatus> Snapshot()
    {
        var result = new Dictionary<string, TunnelStatus>(StringComparer.Ordinal);
        foreach (var (id, status) in _idle)
            result[id] = status;
        foreach (var (id, runner) in _runners)
            result[id] = runner.Status;
        return result;
    }

    public IPEndPoint? ProxyEndpoint(string tunnelId)
        => _runners.TryGetValue(tunnelId, out var runner) && TunnelStates.IsUsable(runner.Status.State)
            ? new IPEndPoint(IPAddress.Loopback, runner.SocksPort)
            : null;

    public async Task ReloadAsync(CancellationToken ct)
    {
        var rows = await tunnels.ListAsync(ct);
        await _reloadLock.WaitAsync(ct);
        try
        {
            // Deleted tunnels stop first: a recreated tunnel may reuse the freed loopback port right away.
            var current = rows.Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var id in _runners.Keys.Concat(_idle.Keys).Concat(_names.Keys).Distinct().Where(id => !current.Contains(id)).ToList())
            {
                await StopRunnerAsync(id);
                _idle.TryRemove(id, out _);
                _names.TryRemove(id, out _);
            }
            foreach (var row in rows)
            {
                _names[row.Id] = row.Name;
                await ApplyAsync(row);
            }
        }
        finally
        {
            _reloadLock.Release();
        }
    }

    public async Task<TunnelTestResult> TestAsync(string tunnelId, CancellationToken ct)
    {
        if (!_runners.ContainsKey(tunnelId))
            await ReloadAsync(ct);
        if (_runners.TryGetValue(tunnelId, out var runner))
            return await runner.TestAsync(ct);

        var status = GetStatus(tunnelId);
        return new TunnelTestResult
        {
            Success = false,
            HandshakeOk = false,
            State = status?.State ?? TunnelStates.Down,
            Error = status?.State == TunnelStates.Disabled ? "The tunnel is disabled." : status?.LastError ?? "unknown tunnel",
        };
    }

    /// <summary>OS process id of a tunnel's running helper (tests), or null.</summary>
    internal int? HelperProcessId(string tunnelId)
        => _runners.TryGetValue(tunnelId, out var runner) ? runner.ProcessId : null;

    /// <summary>Stops every helper (server shutdown); statuses stay readable.</summary>
    public async Task StopAllAsync(CancellationToken ct)
    {
        await _reloadLock.WaitAsync(ct);
        try
        {
            await Task.WhenAll(_runners.Keys.ToList().Select(StopRunnerAsync));
        }
        finally
        {
            _reloadLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
            return;
        await StopAllAsync(CancellationToken.None);
    }

    private async Task ApplyAsync(TunnelEntity row)
    {
        if (!row.Enabled)
        {
            await ParkAsync(row.Id, TunnelStates.Disabled, null);
            return;
        }
        if (!options.Value.Tunnels.Enabled)
        {
            await ParkAsync(row.Id, TunnelStates.Down, DisabledByOptionsError);
            return;
        }
        var privateKey = tunnels.PrivateKey(row);
        if (string.IsNullOrEmpty(privateKey))
        {
            await ParkAsync(row.Id, TunnelStates.Down, NoPrivateKeyError);
            return;
        }

        var config = BuildHelperConfig(row, privateKey);
        var fingerprint = Fingerprint(config);
        if (_runners.TryGetValue(row.Id, out var existing))
        {
            if (existing.Fingerprint == fingerprint)
            {
                existing.Name = row.Name;
                return;
            }
            await StopRunnerAsync(row.Id);
        }
        _idle.TryRemove(row.Id, out _);
        var runner = new TunnelRunner(row.Id, row.Name, config, fingerprint, launcher, timings, time, logger);
        _runners[row.Id] = runner;
        runner.Start();
    }

    private async Task ParkAsync(string id, string state, string? lastError)
    {
        await StopRunnerAsync(id);
        _idle.AddOrUpdate(
            id,
            _ => new TunnelStatus { State = state, Since = time.GetUtcNow(), LastError = lastError },
            (_, previous) => previous.State == state && previous.LastError == lastError
                ? previous
                : new TunnelStatus { State = state, Since = time.GetUtcNow(), LastError = lastError });
    }

    private async Task StopRunnerAsync(string id)
    {
        if (!_runners.TryRemove(id, out var runner))
            return;
        await runner.StopAsync();
        logger.LogInformation("Tunnel {TunnelName} ({TunnelId}) helper stopped", runner.Name, id);
    }

    private TunnelHelperConfig BuildHelperConfig(TunnelEntity row, string privateKey)
    {
        var exitCheckUrl = options.Value.Tunnels.ExitCheckUrl;
        if (string.IsNullOrWhiteSpace(exitCheckUrl))
            exitCheckUrl = TunnelPresets.Find(row.Preset)?.ExitIpCheckUrl ?? TunnelPresets.GenericExitCheckUrl;
        var presharedKey = tunnels.PresharedKey(row);
        return new TunnelHelperConfig
        {
            PrivateKey = privateKey,
            PeerPublicKey = row.PeerPublicKey,
            PresharedKey = string.IsNullOrEmpty(presharedKey) ? null : presharedKey,
            Endpoint = row.Endpoint,
            Addresses = TunnelConfigService.ParseList(row.Addresses),
            Dns = TunnelConfigService.ParseList(row.Dns),
            Mtu = row.Mtu,
            Keepalive = row.Keepalive,
            AllowedIps = TunnelConfigService.ParseList(row.AllowedIps),
            SocksPort = row.LocalPort,
            StatusPort = StatusPortFor(row.LocalPort),
            ExitCheckUrl = exitCheckUrl,
        };
    }

    /// <summary>The helper's loopback status port: the SOCKS port shifted past the tunnel port range.</summary>
    public static int StatusPortFor(int socksPort) => socksPort + 100;

    private static string Fingerprint(TunnelHelperConfig config)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(config);
        return Convert.ToHexString(SHA256.HashData(json));
    }
}

/// <summary>Loads the stored tunnels when the server starts and stops every helper when it shuts down.</summary>
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

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (supervisor is TunnelSupervisor real)
            await real.StopAllAsync(cancellationToken);
    }
}

/// <summary>The state machine of one enabled tunnel: owns the helper process and the restart loop.</summary>
internal sealed class TunnelRunner
{
    private readonly TunnelHelperConfig _config;
    private readonly ITunnelHelperLauncher _launcher;
    private readonly TunnelSupervisorTimings _timings;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _probeLock = new(1, 1);
    private Task _loop = Task.CompletedTask;
    private volatile ITunnelHelperProcess? _process;
    private volatile TunnelStatus _status;
    private volatile string _name;
    private DateTimeOffset _startedAt;
    private DateTimeOffset? _lastExitCheck;
    private bool _everConnected;
    private TimeSpan _backoff;

    public TunnelRunner(
        string id,
        string name,
        TunnelHelperConfig config,
        string fingerprint,
        ITunnelHelperLauncher launcher,
        TunnelSupervisorTimings timings,
        TimeProvider time,
        ILogger logger)
    {
        Id = id;
        _name = name;
        _config = config;
        Fingerprint = fingerprint;
        _launcher = launcher;
        _timings = timings;
        _time = time;
        _logger = logger;
        _backoff = timings.RestartBackoffInitial;
        _status = new TunnelStatus { State = TunnelStates.Starting, Since = time.GetUtcNow() };
    }

    public string Id { get; }
    public string Fingerprint { get; }

    public string Name
    {
        get => _name;
        set => _name = value;
    }

    public TunnelStatus Status => _status;

    /// <summary>The SOCKS5 port of the running helper (the stored port while none runs).</summary>
    public int SocksPort => _process is { SocksPort: > 0 } process ? process.SocksPort : _config.SocksPort;

    public int? ProcessId => _process?.ProcessId;

    public void Start() => _loop = Task.Run(() => RunAsync(_cts.Token));

    public async Task StopAsync()
    {
        _cts.Cancel();
        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            _logger.LogDebug(e, "Tunnel {TunnelName} loop ended with an error", _name);
        }
        var process = _process;
        _process = null;
        if (process is not null)
        {
            try
            {
                await process.StopAsync(_timings.StopGrace, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                await process.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>A fresh status read plus exit check, applied to the state machine and reported.</summary>
    public async Task<TunnelTestResult> TestAsync(CancellationToken ct)
    {
        var process = _process;
        if (process is null || process.HasExited)
        {
            var current = _status;
            return new TunnelTestResult
            {
                Success = false,
                HandshakeOk = false,
                State = current.State,
                LastHandshakeUtc = current.LastHandshakeUtc,
                Error = current.LastError ?? "the tunnel helper is not running",
            };
        }

        HelperStatus status;
        try
        {
            status = await process.GetStatusAsync(ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return new TunnelTestResult
            {
                Success = false,
                HandshakeOk = false,
                State = _status.State,
                Error = $"helper status endpoint unreachable: {e.Message}",
            };
        }

        var exit = await EvaluateAsync(process, status, forceExitCheck: true, ct).ConfigureAwait(false);
        var after = _status;
        var handshakeOk = status.LastHandshakeUtc is { } hs && _time.GetUtcNow() - hs <= _timings.HandshakeStale;
        return new TunnelTestResult
        {
            Success = handshakeOk && exit?.Ok == true,
            HandshakeOk = handshakeOk,
            State = after.State,
            ExitIp = exit?.Ok == true ? exit.Ip : null,
            LatencyMs = exit?.Ok == true ? exit.LatencyMs : null,
            LastHandshakeUtc = status.LastHandshakeUtc,
            Error = after.State == TunnelStates.Connected ? null : after.LastError ?? exit?.Error,
        };
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            ITunnelHelperProcess process;
            try
            {
                process = _launcher.Start(_config);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                Transition(TunnelStates.Down, e.Message);
                if (!await WaitBackoffAsync(ct).ConfigureAwait(false))
                    return;
                continue;
            }

            _process = process;
            _startedAt = _time.GetUtcNow();
            _lastExitCheck = null;
            Transition(TunnelStates.Starting, null);
            try
            {
                if (await process.WaitForReadyAsync(_timings.ReadyTimeout, ct).ConfigureAwait(false))
                {
                    await Task.Delay(_timings.FirstPollDelay, ct).ConfigureAwait(false);
                    await PollAsync(process, ct).ConfigureAwait(false);
                }
                else
                {
                    Transition(TunnelStates.Down, process.HasExited ? ExitReason(process) : "helper did not report ready in time");
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                _logger.LogError(e, "Tunnel {TunnelName} supervisor loop failed", _name);
                Transition(TunnelStates.Down, $"supervisor error: {e.Message}");
            }
            finally
            {
                if (!ct.IsCancellationRequested)
                {
                    _process = null;
                    await process.DisposeAsync().ConfigureAwait(false);
                }
            }

            if (!await WaitBackoffAsync(ct).ConfigureAwait(false))
                return;
        }
    }

    private async Task<bool> WaitBackoffAsync(CancellationToken ct)
    {
        var delay = _backoff;
        _backoff = TimeSpan.FromTicks(Math.Min(_backoff.Ticks * 2, _timings.RestartBackoffMax.Ticks));
        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task PollAsync(ITunnelHelperProcess process, CancellationToken ct)
    {
        var statusFailures = 0;
        while (!ct.IsCancellationRequested)
        {
            if (process.HasExited)
            {
                Transition(TunnelStates.Down, ExitReason(process));
                return;
            }
            HelperStatus status;
            try
            {
                status = await process.GetStatusAsync(ct).ConfigureAwait(false);
                statusFailures = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                if (process.HasExited)
                {
                    Transition(TunnelStates.Down, ExitReason(process));
                    return;
                }
                if (++statusFailures >= _timings.StatusFailuresBeforeRestart)
                {
                    Transition(TunnelStates.Down, $"helper status endpoint unreachable: {e.Message}");
                    await process.StopAsync(_timings.StopGrace, ct).ConfigureAwait(false);
                    return;
                }
                await Task.Delay(_timings.PollInterval, ct).ConfigureAwait(false);
                continue;
            }

            await EvaluateAsync(process, status, forceExitCheck: false, ct).ConfigureAwait(false);
            await Task.Delay(_timings.PollInterval, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Applies one status reading (and an exit check when due or forced) to the state machine.</summary>
    private async Task<HelperExitCheck?> EvaluateAsync(ITunnelHelperProcess process, HelperStatus status, bool forceExitCheck, CancellationToken ct)
    {
        await _probeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var now = _time.GetUtcNow();
            var endpoint = string.IsNullOrEmpty(status.Endpoint) ? _config.Endpoint : status.Endpoint;
            if (status.LastHandshakeUtc is not { } handshake)
            {
                var waited = now - _startedAt;
                if (waited > _timings.HandshakeTimeout)
                    Transition(TunnelStates.Down, status.LastError ?? $"handshake timeout: no handshake with {endpoint} after {(int)waited.TotalSeconds}s", status);
                else
                    Transition(TunnelStates.Starting, status.LastError, status);
                return null;
            }

            var age = now - handshake;
            if (age > _timings.HandshakeStale)
            {
                Transition(TunnelStates.Degraded, status.LastError ?? $"handshake stale: last handshake with {endpoint} {(int)age.TotalSeconds}s ago", status);
                return null;
            }

            var due = forceExitCheck || _status.State != TunnelStates.Connected || _lastExitCheck is null || now - _lastExitCheck > _timings.ExitCheckInterval;
            if (!due)
            {
                Transition(TunnelStates.Connected, null, status);
                return null;
            }

            HelperExitCheck exit;
            try
            {
                exit = await process.ExitCheckAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e)
            {
                exit = new HelperExitCheck { Ok = false, Error = $"exit check failed: {e.Message}" };
            }
            _lastExitCheck = _time.GetUtcNow();

            if (exit.Ok)
            {
                _everConnected = true;
                _backoff = _timings.RestartBackoffInitial;
                Transition(TunnelStates.Connected, null, status, exit);
            }
            else if (_everConnected || now - _startedAt > _timings.HandshakeTimeout)
            {
                Transition(TunnelStates.Degraded, exit.Error ?? "exit check failed", status);
            }
            else
            {
                Transition(TunnelStates.Starting, exit.Error, status);
            }
            return exit;
        }
        finally
        {
            _probeLock.Release();
        }
    }

    private static string ExitReason(ITunnelHelperProcess process)
    {
        var reason = $"helper exited with code {process.ExitCode?.ToString() ?? "?"}";
        return process.LastErrorMessage is { Length: > 0 } message ? $"{reason}: {message}" : reason;
    }

    private void Transition(string state, string? lastError, HelperStatus? status = null, HelperExitCheck? exit = null)
    {
        var previous = _status;
        var now = _time.GetUtcNow();
        var keepExit = state == TunnelStates.Connected && exit is null;
        var next = new TunnelStatus
        {
            State = state,
            Since = previous.State == state ? previous.Since : now,
            LastHandshakeUtc = status?.LastHandshakeUtc ?? previous.LastHandshakeUtc,
            ExitIp = exit?.Ok == true ? exit.Ip : keepExit ? previous.ExitIp : null,
            LatencyMs = exit?.Ok == true ? exit.LatencyMs : keepExit ? previous.LatencyMs : null,
            RxBytes = status?.RxBytes ?? previous.RxBytes,
            TxBytes = status?.TxBytes ?? previous.TxBytes,
            LastError = lastError,
        };
        _status = next;

        if (previous.State != state)
        {
            var level = state is TunnelStates.Connected or TunnelStates.Starting ? LogLevel.Information : LogLevel.Warning;
            _logger.Log(level, "Tunnel {TunnelName} ({TunnelId}) {PreviousState} -> {State}{Reason}",
                _name, Id, previous.State, state, lastError is null ? string.Empty : $": {lastError}");
        }
        else if (lastError is not null && lastError != previous.LastError)
        {
            _logger.LogDebug("Tunnel {TunnelName} ({TunnelId}) {State}: {Reason}", _name, Id, state, lastError);
        }
    }
}
