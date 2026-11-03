using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace Streamarr.Tests.Shared;

/// <summary>Finds a built streamarr-tunnel for tests and harnesses: next to the assembly (copied by the csproj) or the repo's dist/host build; builds it with Go when possible.</summary>
public static class TunnelHelperBinary
{
    public static string BinaryName => OperatingSystem.IsWindows() ? "streamarr-tunnel.exe" : "streamarr-tunnel";

    private static readonly Lazy<string?> Located = new(LocateOrBuild, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string? Locate() => Located.Value;

    private static string? LocateOrBuild()
    {
        var local = Path.Combine(AppContext.BaseDirectory, BinaryName);
        if (File.Exists(local))
            return local;
        var tunnelDir = FindTunnelSourceDir();
        if (tunnelDir is null)
            return null;
        var dist = Path.Combine(tunnelDir, "dist", "host", BinaryName);
        if (File.Exists(dist))
            return dist;
        try
        {
            var build = new ProcessStartInfo("bash", Path.Combine(tunnelDir, "build.sh"))
            {
                WorkingDirectory = tunnelDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = Process.Start(build);
            if (process is null || !process.WaitForExit(TimeSpan.FromMinutes(5)) || process.ExitCode != 0)
                return null;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
        return File.Exists(dist) ? dist : null;
    }

    private static string? FindTunnelSourceDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "server", "tunnel", "go.mod");
            if (File.Exists(candidate))
                return Path.GetDirectoryName(candidate);
            var sibling = Path.Combine(dir.FullName, "tunnel", "go.mod");
            if (File.Exists(sibling))
                return Path.GetDirectoryName(sibling);
        }
        return null;
    }
}

/// <summary>
/// A streamarr-tunnel in server/test mode: the "VPN server" side of a loopback WireGuard lab. It listens on UDP,
/// forwards addresses inside the tunnel to host services and answers DNS; <c>config</c> is the JSON the helper reads
/// on stdin (see server/tunnel/README.md). Tests and the E2E harness use it to prove routing without a VPN account.
/// </summary>
public sealed class LabVpnPeer : IAsyncDisposable
{
    private readonly Process _process;

    private LabVpnPeer(Process process, string readyLine)
    {
        _process = process;
        ReadyLine = readyLine;
    }

    public int ProcessId => _process.Id;
    public bool HasExited => _process.HasExited;

    /// <summary>The helper's ready line (JSON with the bound ports).</summary>
    public string ReadyLine { get; }

    public static async Task<LabVpnPeer> StartAsync(string helperPath, object config, Action<string>? onStderr = null, CancellationToken ct = default)
    {
        var process = Process.Start(new ProcessStartInfo(helperPath)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException($"could not start {helperPath}");
        _ = Task.Run(async () =>
        {
            while (await process.StandardError.ReadLineAsync().ConfigureAwait(false) is { } line)
                onStderr?.Invoke(line);
        }, CancellationToken.None);
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(config)).ConfigureAwait(false);
        await process.StandardInput.FlushAsync(ct).ConfigureAwait(false);
        string? ready;
        try
        {
            ready = await process.StandardOutput.ReadLineAsync(ct).AsTask().WaitAsync(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            ready = null;
        }
        if (ready is null || !ready.Contains("\"ready\"", StringComparison.Ordinal))
        {
            KillQuietly(process);
            process.Dispose();
            throw new InvalidOperationException($"the lab VPN peer did not report ready: {ready ?? "(no output)"}");
        }
        return new LabVpnPeer(process, ready);
    }

    /// <summary>Kills the peer at once, as if the VPN server vanished.</summary>
    public void Kill() => KillQuietly(_process);

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                try
                {
                    _process.StandardInput.Close();
                }
                catch (Exception e) when (e is IOException or InvalidOperationException)
                {
                }
                if (!_process.WaitForExit(3000))
                    KillQuietly(_process);
            }
            await _process.WaitForExitAsync().ConfigureAwait(false);
        }
        finally
        {
            _process.Dispose();
        }
    }

    private static void KillQuietly(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }
}

/// <summary>Free loopback ports for lab fixtures.</summary>
public static class FreePorts
{
    public static int Udp()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)socket.LocalEndPoint!).Port;
    }

    public static int Tcp()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
