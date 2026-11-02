using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tunnels;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>The supervisor state machine against a scripted fake helper: connect, handshake timeout, stale handshake, crashes, reloads.</summary>
public sealed class TunnelSupervisorTests : IAsyncLifetime
{
    private static readonly TimeSpan WaitLimit = TimeSpan.FromSeconds(8);

    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("streamarr-supervisor-");
    private readonly ManualClock _clock = new(new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero));
    private readonly FakeLauncher _launcher = new();
    private readonly StreamarrOptions _options = new();
    private readonly TunnelSupervisorTimings _timings = new()
    {
        PollInterval = TimeSpan.FromMilliseconds(20),
        FirstPollDelay = TimeSpan.Zero,
        ReadyTimeout = TimeSpan.FromSeconds(2),
        HandshakeTimeout = TimeSpan.FromSeconds(30),
        HandshakeStale = TimeSpan.FromSeconds(180),
        ExitCheckInterval = TimeSpan.FromHours(1),
        RestartBackoffInitial = TimeSpan.FromMilliseconds(10),
        RestartBackoffMax = TimeSpan.FromMilliseconds(40),
        StopGrace = TimeSpan.FromMilliseconds(200),
        StatusFailuresBeforeRestart = 2,
    };
    private TunnelConfigService _tunnels = null!;
    private TunnelSupervisor _supervisor = null!;

    public async Task InitializeAsync()
    {
        var options = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(_directory.FullName, "tunnels.db")}")
            .Options;
        await using (var setup = new StreamarrDbContext(options))
            await setup.Database.EnsureCreatedAsync();
        _tunnels = new TunnelConfigService(new PooledDbContextFactory<StreamarrDbContext>(options), new PrefixProtector(), _clock);
        _supervisor = new TunnelSupervisor(
            _tunnels,
            _launcher,
            _timings,
            Microsoft.Extensions.Options.Options.Create(_options),
            _clock,
            NullLogger<TunnelSupervisor>.Instance);
    }

    public async Task DisposeAsync()
    {
        await _supervisor.DisposeAsync();
        _directory.Delete(recursive: true);
    }

    private Task<TunnelEntity> CreateAsync(bool enabled = true, string? privateKey = TunnelValidationTests.PrivateKey, string endpoint = "185.65.134.86:51820")
        => _tunnels.CreateAsync(new NormalizedTunnel(
            "Mullvad SE", "mullvad", endpoint, ["10.64.12.3/32"], ["10.64.0.1"], null, 25,
            TunnelValidationTests.PeerKey, ["0.0.0.0/0", "::/0"], privateKey, null), enabled, CancellationToken.None);

    private async Task<FakeProcess> StartedAsync(int index)
    {
        await WaitUntilAsync(() => _launcher.Started.Count > index, $"helper #{index + 1} to start");
        return _launcher.Started[index];
    }

    private async Task<Contracts.TunnelStatus> WaitForStateAsync(string id, string state)
    {
        await WaitUntilAsync(() => _supervisor.GetStatus(id)?.State == state, $"tunnel to become {state} (is {_supervisor.GetStatus(id)?.State}: {_supervisor.GetStatus(id)?.LastError})");
        return _supervisor.GetStatus(id)!;
    }

    private static async Task WaitUntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow + WaitLimit;
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                Assert.Fail($"Timed out waiting for {what}.");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task EnabledTunnel_StartsHelperWithDecryptedConfig_AndConnectsAfterHandshakeAndExitCheck()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);

        var process = await StartedAsync(0);
        Assert.Equal(entity.LocalPort, process.Config.SocksPort);
        Assert.Equal(entity.LocalPort + 100, process.Config.StatusPort);
        Assert.Equal(TunnelValidationTests.PrivateKey, process.Config.PrivateKey);
        Assert.Null(process.Config.PresharedKey);
        Assert.Equal(["10.64.0.1"], process.Config.Dns);
        Assert.Equal(25, process.Config.Keepalive);
        Assert.Equal(TunnelPresets.Find("mullvad")!.ExitIpCheckUrl, process.Config.ExitCheckUrl);
        Assert.Equal(TunnelStates.Starting, _supervisor.GetStatus(entity.Id)!.State);
        Assert.Null(_supervisor.ProxyEndpoint(entity.Id));

        process.Ready();
        await Task.Delay(100);
        Assert.Equal(TunnelStates.Starting, _supervisor.GetStatus(entity.Id)!.State);
        Assert.Equal(0, process.ExitChecks);

        process.Handshake(_clock.GetUtcNow());
        var status = await WaitForStateAsync(entity.Id, TunnelStates.Connected);
        Assert.Equal("203.0.113.9", status.ExitIp);
        Assert.Equal(42, status.LatencyMs);
        Assert.Equal(10, status.RxBytes);
        Assert.Null(status.LastError);
        Assert.Equal(new IPEndPoint(IPAddress.Loopback, entity.LocalPort), _supervisor.ProxyEndpoint(entity.Id));
        Assert.Equal("Mullvad SE", _supervisor.GetName(entity.Id));
        Assert.Equal(1, process.ExitChecks);
    }

    [Fact]
    public async Task NoHandshake_BecomesDownWithHandshakeTimeout_AndRecoversWithoutRestart()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);
        process.Ready();

        _clock.Advance(TimeSpan.FromSeconds(31));
        var down = await WaitForStateAsync(entity.Id, TunnelStates.Down);
        Assert.StartsWith("handshake timeout: no handshake with 185.65.134.86:51820", down.LastError);
        Assert.Null(_supervisor.ProxyEndpoint(entity.Id));

        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);
        Assert.Single(_launcher.Started);
    }

    [Fact]
    public async Task StaleHandshake_IsDegraded_UntilTheNextHandshake()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);
        process.Ready();
        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);

        _clock.Advance(TimeSpan.FromSeconds(200));
        var degraded = await WaitForStateAsync(entity.Id, TunnelStates.Degraded);
        Assert.StartsWith("handshake stale: last handshake with 185.65.134.86:51820 200s ago", degraded.LastError);
        Assert.Null(_supervisor.ProxyEndpoint(entity.Id));

        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);
    }

    [Fact]
    public async Task HelperExit_IsDownWithTheLastErrorLine_AndRestarts()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var first = await StartedAsync(0);
        first.Ready();
        first.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);

        first.Exit(3, "wireguard: handshake did not complete");
        var down = await WaitForStateAsync(entity.Id, TunnelStates.Down);
        Assert.Equal("helper exited with code 3: wireguard: handshake did not complete", down.LastError);

        var second = await StartedAsync(1);
        Assert.True(first.Disposed);
        second.Ready();
        second.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);
    }

    [Fact]
    public async Task FailedExitCheck_AfterConnected_IsDegraded()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);
        process.Ready();
        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);

        process.ExitCheck = () => new HelperExitCheck { Ok = false, Error = "exit check failed: dial tcp: i/o timeout" };
        var test = await _supervisor.TestAsync(entity.Id, CancellationToken.None);
        Assert.False(test.Success);
        Assert.True(test.HandshakeOk);
        Assert.Equal(TunnelStates.Degraded, test.State);
        Assert.Equal("exit check failed: dial tcp: i/o timeout", test.Error);
        Assert.Null(_supervisor.ProxyEndpoint(entity.Id));

        process.ExitCheck = () => new HelperExitCheck { Ok = true, Ip = "198.51.100.2", LatencyMs = 7 };
        var recovered = await WaitForStateAsync(entity.Id, TunnelStates.Connected);
        Assert.Equal("198.51.100.2", recovered.ExitIp);
    }

    [Fact]
    public async Task TestAsync_RunsAFreshExitCheck()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);
        process.Ready();
        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);
        var before = process.ExitChecks;

        process.ExitCheck = () => new HelperExitCheck { Ok = true, Ip = "198.51.100.7", LatencyMs = 12.5 };
        var result = await _supervisor.TestAsync(entity.Id, CancellationToken.None);

        Assert.True(result.Success);
        Assert.True(result.HandshakeOk);
        Assert.Equal(TunnelStates.Connected, result.State);
        Assert.Equal("198.51.100.7", result.ExitIp);
        Assert.Equal(12.5, result.LatencyMs);
        Assert.NotNull(result.LastHandshakeUtc);
        Assert.Equal(before + 1, process.ExitChecks);
    }

    [Fact]
    public async Task MissingHelperBinary_IsDownWithTheLookupMessage_AndKeepsRetrying()
    {
        _launcher.StartError = () => new TunnelHelperStartException("helper binary not found (looked for /app/streamarr-tunnel)");
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);

        var status = await WaitForStateAsync(entity.Id, TunnelStates.Down);
        Assert.Equal("helper binary not found (looked for /app/streamarr-tunnel)", status.LastError);
        await WaitUntilAsync(() => _launcher.Attempts >= 3, "restart attempts");
        Assert.Empty(_launcher.Started);
    }

    [Fact]
    public async Task TunnelsSwitchedOff_NeverStartAHelper()
    {
        _options.Tunnels.Enabled = false;
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);

        var status = _supervisor.GetStatus(entity.Id)!;
        Assert.Equal(TunnelStates.Down, status.State);
        Assert.Equal(TunnelSupervisor.DisabledByOptionsError, status.LastError);
        Assert.Equal(0, _launcher.Attempts);

        var test = await _supervisor.TestAsync(entity.Id, CancellationToken.None);
        Assert.False(test.Success);
        Assert.Equal(TunnelSupervisor.DisabledByOptionsError, test.Error);
    }

    [Fact]
    public async Task DisabledTunnel_IsDisabledWithoutAHelper_AndNoPrivateKeyIsDown()
    {
        var disabled = await CreateAsync(enabled: false);
        var keyless = await CreateAsync(privateKey: null);
        await _supervisor.ReloadAsync(CancellationToken.None);

        Assert.Equal(TunnelStates.Disabled, _supervisor.GetStatus(disabled.Id)!.State);
        Assert.Equal("The tunnel is disabled.", (await _supervisor.TestAsync(disabled.Id, CancellationToken.None)).Error);
        var keylessStatus = _supervisor.GetStatus(keyless.Id)!;
        Assert.Equal(TunnelStates.Down, keylessStatus.State);
        Assert.Equal(TunnelSupervisor.NoPrivateKeyError, keylessStatus.LastError);
        Assert.Equal(0, _launcher.Attempts);
    }

    [Fact]
    public async Task DisablingARunningTunnel_StopsTheHelper()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);
        process.Ready();
        process.Handshake(_clock.GetUtcNow());
        await WaitForStateAsync(entity.Id, TunnelStates.Connected);

        await _tunnels.UpdateAsync(entity.Id, Settings(), enabled: false, clearPresharedKey: false, CancellationToken.None);
        await _supervisor.ReloadAsync(CancellationToken.None);

        Assert.True(process.StopCalls >= 1);
        Assert.Equal(TunnelStates.Disabled, _supervisor.GetStatus(entity.Id)!.State);
        Assert.Null(_supervisor.ProxyEndpoint(entity.Id));
    }

    [Fact]
    public async Task ChangedConfig_RestartsTheHelper_UnchangedConfigDoesNot()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var first = await StartedAsync(0);

        await _supervisor.ReloadAsync(CancellationToken.None);
        Assert.Single(_launcher.Started);

        await _tunnels.UpdateAsync(entity.Id, Settings(endpoint: "198.51.100.10:51820"), enabled: null, clearPresharedKey: false, CancellationToken.None);
        await _supervisor.ReloadAsync(CancellationToken.None);

        var second = await StartedAsync(1);
        Assert.True(first.StopCalls >= 1);
        Assert.Equal("198.51.100.10:51820", second.Config.Endpoint);
        Assert.Equal(first.Config.SocksPort, second.Config.SocksPort);
    }

    [Fact]
    public async Task DeletedTunnel_IsForgotten_AndItsHelperStopped()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var process = await StartedAsync(0);

        await _tunnels.DeleteAsync(entity.Id, force: true, CancellationToken.None);
        await _supervisor.ReloadAsync(CancellationToken.None);

        Assert.True(process.StopCalls >= 1);
        Assert.Null(_supervisor.GetStatus(entity.Id));
        Assert.Null(_supervisor.GetName(entity.Id));
        Assert.Empty(_supervisor.Snapshot());
    }

    [Fact]
    public async Task UnreachableStatusEndpoint_IsDown_AndRestartsTheHelper()
    {
        var entity = await CreateAsync();
        await _supervisor.ReloadAsync(CancellationToken.None);
        var first = await StartedAsync(0);
        first.Ready();
        first.StatusFailure = () => new HttpRequestException("Connection refused");

        var down = await WaitForStateAsync(entity.Id, TunnelStates.Down);
        Assert.StartsWith("helper status endpoint unreachable: Connection refused", down.LastError);
        await StartedAsync(1);
        Assert.True(first.StopCalls >= 1);
    }

    private static NormalizedTunnel Settings(string endpoint = "185.65.134.86:51820") => new(
        "Mullvad SE", "mullvad", endpoint, ["10.64.12.3/32"], ["10.64.0.1"], null, 25,
        TunnelValidationTests.PeerKey, ["0.0.0.0/0", "::/0"], null, null);

    private sealed class PrefixProtector : ISecretProtector
    {
        public string? Protect(string? plaintext) => string.IsNullOrEmpty(plaintext) ? null : $"protected:{plaintext}";
        public string Unprotect(string? ciphertext) => ciphertext?.StartsWith("protected:", StringComparison.Ordinal) == true ? ciphertext["protected:".Length..] : string.Empty;
    }

    internal sealed class FakeLauncher : ITunnelHelperLauncher
    {
        public List<FakeProcess> Started { get; } = [];
        public int Attempts { get; private set; }
        public Func<Exception>? StartError { get; set; }

        public ITunnelHelperProcess Start(TunnelHelperConfig config)
        {
            lock (Started)
            {
                Attempts++;
                if (StartError is { } error)
                    throw error();
                var process = new FakeProcess(config);
                Started.Add(process);
                return process;
            }
        }
    }

    internal sealed class FakeProcess(TunnelHelperConfig config) : ITunnelHelperProcess
    {
        private readonly TaskCompletionSource<bool> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private volatile HelperStatus _status = new() { SocksPort = config.SocksPort, StatusPort = config.StatusPort, Endpoint = config.Endpoint };
        private int _exitChecks;

        public TunnelHelperConfig Config { get; } = config;
        public int SocksPort => Config.SocksPort;
        public int StatusPort => Config.StatusPort;
        public bool HasExited { get; private set; }
        public int? ExitCode { get; private set; }
        public int? ProcessId => null;
        public string? LastErrorMessage { get; private set; }
        public int StopCalls { get; private set; }
        public bool Disposed { get; private set; }
        public int ExitChecks => Volatile.Read(ref _exitChecks);
        public Func<HelperExitCheck> ExitCheck { get; set; } = () => new HelperExitCheck { Ok = true, Ip = "203.0.113.9", LatencyMs = 42 };
        public Func<Exception>? StatusFailure { get; set; }

        public void Ready() => _ready.TrySetResult(true);

        public void Handshake(DateTimeOffset at) => _status = _status with { LastHandshakeUtc = at, RxBytes = 10, TxBytes = 20 };

        public void Exit(int code, string? lastError)
        {
            HasExited = true;
            ExitCode = code;
            LastErrorMessage = lastError;
            _ready.TrySetResult(false);
        }

        public async Task<bool> WaitForReadyAsync(TimeSpan timeout, CancellationToken ct)
        {
            var completed = await Task.WhenAny(_ready.Task, Task.Delay(timeout, ct));
            return completed == _ready.Task && await _ready.Task;
        }

        public Task<HelperStatus> GetStatusAsync(CancellationToken ct)
            => StatusFailure is { } failure ? Task.FromException<HelperStatus>(failure()) : Task.FromResult(_status);

        public Task<HelperExitCheck> ExitCheckAsync(CancellationToken ct)
        {
            Interlocked.Increment(ref _exitChecks);
            return Task.FromResult(ExitCheck());
        }

        public Task StopAsync(TimeSpan grace, CancellationToken ct)
        {
            StopCalls++;
            HasExited = true;
            ExitCode ??= 0;
            _ready.TrySetResult(false);
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
