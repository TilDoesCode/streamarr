using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Tunnels;

/// <summary>What the server writes to the helper's stdin (camelCase JSON, see server/tunnel/README.md).</summary>
public sealed record TunnelHelperConfig
{
    public required string PrivateKey { get; init; }
    public required string PeerPublicKey { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? PresharedKey { get; init; }
    public required string Endpoint { get; init; }
    public required IReadOnlyList<string> Addresses { get; init; }
    public required IReadOnlyList<string> Dns { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Mtu { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Keepalive { get; init; }
    public required IReadOnlyList<string> AllowedIps { get; init; }
    public required int SocksPort { get; init; }
    public required int StatusPort { get; init; }
    public required string ExitCheckUrl { get; init; }
}

/// <summary>GET /status of a helper.</summary>
public sealed record HelperStatus
{
    public int SocksPort { get; init; }
    public int StatusPort { get; init; }
    public string? Endpoint { get; init; }
    public double UptimeSeconds { get; init; }
    public DateTimeOffset? LastHandshakeUtc { get; init; }
    public double? HandshakeAgeSeconds { get; init; }
    public long RxBytes { get; init; }
    public long TxBytes { get; init; }
    public string? LastError { get; init; }
}

/// <summary>GET /exit of a helper: the exit-IP check performed through the tunnel.</summary>
public sealed record HelperExitCheck
{
    public bool Ok { get; init; }
    public string? Ip { get; init; }
    public double LatencyMs { get; init; }
    public string? Error { get; init; }
}

/// <summary>The helper could not be started at all (missing binary, not executable).</summary>
public sealed class TunnelHelperStartException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>A running (or exited) helper as the supervisor sees it; real processes and test fakes implement it.</summary>
public interface ITunnelHelperProcess : IAsyncDisposable
{
    /// <summary>Completes true once the helper printed its ready line, false when it exited or the timeout passed.</summary>
    Task<bool> WaitForReadyAsync(TimeSpan timeout, CancellationToken ct);

    int SocksPort { get; }
    int StatusPort { get; }
    bool HasExited { get; }
    int? ExitCode { get; }

    /// <summary>OS process id of the helper; null for fakes.</summary>
    int? ProcessId { get; }

    /// <summary>The message of the last error line the helper logged, for <c>lastError</c> after an exit.</summary>
    string? LastErrorMessage { get; }

    Task<HelperStatus> GetStatusAsync(CancellationToken ct);
    Task<HelperExitCheck> ExitCheckAsync(CancellationToken ct);

    /// <summary>Asks the helper to stop (stdin close), then kills it after a grace period.</summary>
    Task StopAsync(TimeSpan grace, CancellationToken ct);
}

/// <summary>Starts helper processes; the supervisor never touches <see cref="Process"/> directly so tests can fake it.</summary>
public interface ITunnelHelperLauncher
{
    /// <exception cref="TunnelHelperStartException">The binary is missing or cannot be started.</exception>
    ITunnelHelperProcess Start(TunnelHelperConfig config);
}

/// <summary>Finds the helper binary: the configured path, next to the server assembly, or the repo's dev build output.</summary>
public sealed class TunnelHelperLocator(IOptions<StreamarrOptions> options, IHostEnvironment environment)
{
    public static string BinaryName => OperatingSystem.IsWindows() ? "streamarr-tunnel.exe" : "streamarr-tunnel";

    /// <summary>Paths tried in order; an explicit <c>Streamarr:Tunnels:HelperPath</c> is the only candidate when set.</summary>
    public IReadOnlyList<string> Candidates()
    {
        var configured = options.Value.Tunnels.HelperPath;
        if (!string.IsNullOrWhiteSpace(configured))
            return [Path.GetFullPath(configured, environment.ContentRootPath)];
        return
        [
            Path.Combine(AppContext.BaseDirectory, BinaryName),
            Path.Combine(environment.ContentRootPath, "tunnel", BinaryName),
            Path.Combine(environment.ContentRootPath, "tunnel", "dist", "host", BinaryName),
        ];
    }

    /// <summary>The first existing candidate, or null.</summary>
    public string? Resolve() => Candidates().FirstOrDefault(File.Exists);

    public string Describe() => string.Join(", ", Candidates());
}

/// <summary>Real helper processes: JSON config on stdin, ready line on stdout, JSON log lines on stderr, status over loopback HTTP.</summary>
public sealed class ProcessTunnelHelperLauncher(TunnelHelperLocator locator, ILogger<ProcessTunnelHelperLauncher> logger) : ITunnelHelperLauncher
{
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        UseProxy = false,
        ConnectTimeout = TimeSpan.FromSeconds(3),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    public ITunnelHelperProcess Start(TunnelHelperConfig config)
    {
        var path = locator.Resolve()
                   ?? throw new TunnelHelperStartException($"helper binary not found (looked for {locator.Describe()})");
        var startInfo = new ProcessStartInfo(path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(path) ?? AppContext.BaseDirectory,
        };
        Process process;
        try
        {
            process = Process.Start(startInfo) ?? throw new TunnelHelperStartException($"helper did not start: {path}");
        }
        catch (Exception e) when (e is not TunnelHelperStartException)
        {
            throw new TunnelHelperStartException($"helper could not be started ({path}): {e.Message}", e);
        }
        return new HelperProcess(process, config, logger);
    }

    private sealed class HelperProcess : ITunnelHelperProcess
    {
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
        private readonly Process _process;
        private readonly ILogger _logger;
        private static readonly TimeSpan StderrDrainGrace = TimeSpan.FromSeconds(1);
        private readonly TaskCompletionSource<bool> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Task _stderrPump;
        private volatile string? _lastError;
        private long _exitedAtTicks;
        private int _stopped;

        public HelperProcess(Process process, TunnelHelperConfig config, ILogger logger)
        {
            _process = process;
            _logger = logger;
            SocksPort = config.SocksPort;
            StatusPort = config.StatusPort;
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => MarkExited();
            if (process.HasExited)
                MarkExited();
            _ = Task.Run(() => PumpAsync(process.StandardOutput, isStdout: true));
            _stderrPump = Task.Run(() => PumpAsync(process.StandardError, isStdout: false));
            _ = Task.Run(() => WriteConfigAsync(config));
        }

        public int SocksPort { get; private set; }
        public int StatusPort { get; private set; }

        /// <summary>True once the process ended and its last stderr lines were read (or a short grace passed), so <see cref="LastErrorMessage"/> is complete.</summary>
        public bool HasExited
        {
            get
            {
                if (!_process.HasExited)
                    return false;
                if (_stderrPump.IsCompleted)
                    return true;
                var exitedAt = Interlocked.Read(ref _exitedAtTicks);
                return exitedAt != 0 && DateTime.UtcNow.Ticks - exitedAt > StderrDrainGrace.Ticks;
            }
        }

        public int? ExitCode => _process.HasExited ? _process.ExitCode : null;
        public int? ProcessId => _process.Id;
        public string? LastErrorMessage => _lastError;

        public async Task<bool> WaitForReadyAsync(TimeSpan timeout, CancellationToken ct)
        {
            var completed = await Task.WhenAny(_ready.Task, Task.Delay(timeout, ct)).ConfigureAwait(false);
            if (completed != _ready.Task || await _ready.Task.ConfigureAwait(false))
                return completed == _ready.Task;
            // Exited before ready: give stderr a moment so the exit reason carries the helper's last line.
            await Task.WhenAny(_stderrPump, Task.Delay(StderrDrainGrace, ct)).ConfigureAwait(false);
            return false;
        }

        private void MarkExited()
        {
            Interlocked.CompareExchange(ref _exitedAtTicks, DateTime.UtcNow.Ticks, 0);
            _ready.TrySetResult(false);
            _exited.TrySetResult();
        }

        public async Task<HelperStatus> GetStatusAsync(CancellationToken ct)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            return await Http.GetFromJsonAsync<HelperStatus>($"http://127.0.0.1:{StatusPort}/status", Json, timeout.Token).ConfigureAwait(false)
                   ?? throw new InvalidOperationException("empty status");
        }

        public async Task<HelperExitCheck> ExitCheckAsync(CancellationToken ct)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            return await Http.GetFromJsonAsync<HelperExitCheck>($"http://127.0.0.1:{StatusPort}/exit", Json, timeout.Token).ConfigureAwait(false)
                   ?? throw new InvalidOperationException("empty exit check");
        }

        public async Task StopAsync(TimeSpan grace, CancellationToken ct)
        {
            if (Interlocked.Exchange(ref _stopped, 1) == 1 || _process.HasExited)
                return;
            try
            {
                _process.StandardInput.Close();
            }
            catch (Exception e) when (e is IOException or InvalidOperationException)
            {
                // Already closed by the helper.
            }
            var exited = await Task.WhenAny(_exited.Task, Task.Delay(grace, ct)).ConfigureAwait(false) == _exited.Task;
            if (!exited && !_process.HasExited)
            {
                _logger.LogWarning("Tunnel helper {Pid} did not stop within {Grace}; killing it", _process.Id, grace);
                try
                {
                    _process.Kill(entireProcessTree: true);
                }
                catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    // Exited between the check and the kill.
                }
                await _exited.Task.WaitAsync(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            }
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await StopAsync(TimeSpan.FromSeconds(3), CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                _logger.LogDebug(e, "Tunnel helper dispose");
            }
            _process.Dispose();
        }

        private async Task WriteConfigAsync(TunnelHelperConfig config)
        {
            try
            {
                var json = JsonSerializer.Serialize(config, Json);
                await _process.StandardInput.WriteLineAsync(json).ConfigureAwait(false);
                await _process.StandardInput.FlushAsync().ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or ObjectDisposedException)
            {
                _lastError ??= $"could not write the config to the helper: {e.Message}";
            }
        }

        private async Task PumpAsync(StreamReader reader, bool isStdout)
        {
            try
            {
                while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
                {
                    if (isStdout)
                        HandleStdout(line);
                    else
                        HandleStderr(line);
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
            {
                // Process gone.
            }
        }

        private void HandleStdout(string line)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (doc.RootElement.TryGetProperty("event", out var ev) && ev.GetString() == "ready")
                {
                    if (doc.RootElement.TryGetProperty("socksPort", out var socks) && socks.TryGetInt32(out var sp) && sp > 0)
                        SocksPort = sp;
                    if (doc.RootElement.TryGetProperty("statusPort", out var status) && status.TryGetInt32(out var stp) && stp > 0)
                        StatusPort = stp;
                    _ready.TrySetResult(true);
                }
            }
            catch (JsonException)
            {
                _logger.LogDebug("Tunnel helper stdout: {Line}", line);
            }
        }

        private void HandleStderr(string line)
        {
            string level = "info", message = line;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (doc.RootElement.TryGetProperty("level", out var l))
                    level = l.GetString() ?? level;
                if (doc.RootElement.TryGetProperty("msg", out var m))
                    message = m.GetString() ?? message;
                if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.String)
                    message = $"{message}: {err.GetString()}";
                if (doc.RootElement.TryGetProperty("field", out var field) && field.ValueKind == JsonValueKind.String)
                    message = $"{message} (field {field.GetString()})";
            }
            catch (JsonException)
            {
                level = "error";
            }
            if (level == "error")
            {
                _lastError = message;
                _logger.LogWarning("Tunnel helper {Pid}: {Message}", _process.Id, message);
            }
            else
            {
                _logger.LogDebug("Tunnel helper {Pid} [{Level}]: {Message}", _process.Id, level, message);
            }
        }
    }
}
