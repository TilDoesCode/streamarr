using System.Runtime.InteropServices;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Security;
using Streamarr.Server.Tunnels;
using Xunit.Abstractions;

namespace Streamarr.Server.Tests.Tunnels;

/// <summary>The real process layer: scripted stand-in helpers for the stdin/stdout/stderr/exit contract, plus the real helper when it is built.</summary>
public sealed class TunnelHelperProcessTests(ITestOutputHelper output) : IDisposable
{
    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory("streamarr-helper-");

    public void Dispose() => _directory.Delete(recursive: true);

    private static TunnelHelperConfig Config(string endpoint = "192.0.2.1:51820", int socksPort = 0, int statusPort = 0) => new()
    {
        PrivateKey = TunnelValidationTests.PrivateKey,
        PeerPublicKey = TunnelValidationTests.PeerKey,
        Endpoint = endpoint,
        Addresses = ["10.64.12.3/32"],
        Dns = ["10.64.0.1"],
        AllowedIps = ["0.0.0.0/0"],
        SocksPort = socksPort,
        StatusPort = statusPort,
        ExitCheckUrl = "http://10.64.0.1/ip",
    };

    private ProcessTunnelHelperLauncher Launcher(string helperPath)
    {
        var options = Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { Tunnels = new TunnelsOptions { HelperPath = helperPath } });
        return new ProcessTunnelHelperLauncher(new TunnelHelperLocator(options, new FakeEnvironment(_directory.FullName)), NullLogger<ProcessTunnelHelperLauncher>.Instance);
    }

    private string Script(string name, string body)
    {
        var path = Path.Combine(_directory.FullName, name);
        File.WriteAllText(path, "#!/bin/sh\n" + body + "\n");
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return path;
    }

    private static bool NoShell => RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

    [Fact]
    public async Task HelperThatExits_ReportsExitCodeAndLastErrorLine()
    {
        if (NoShell)
            return;
        var script = Script("exit3.sh", "printf '%s\\n' '{\"level\":\"info\",\"msg\":\"starting\"}' '{\"level\":\"error\",\"msg\":\"invalid config\",\"field\":\"privateKey\",\"error\":\"must decode to 32 bytes\"}' >&2; exit 3");

        await using var process = Launcher(script).Start(Config());

        Assert.False(await process.WaitForReadyAsync(TimeSpan.FromSeconds(5), CancellationToken.None));
        await WaitUntilAsync(() => process.HasExited);
        Assert.Equal(3, process.ExitCode);
        Assert.Equal("invalid config: must decode to 32 bytes (field privateKey)", process.LastErrorMessage);
    }

    [Fact]
    public async Task HelperThatRuns_ReportsReadyPorts_AndStopsWhenStdinCloses()
    {
        if (NoShell)
            return;
        var script = Script("ready.sh", "read -r config; echo '{\"event\":\"ready\",\"socksPort\":41800,\"statusPort\":45555}'; cat >/dev/null; exit 0");

        await using var process = Launcher(script).Start(Config(socksPort: 41800, statusPort: 0));

        Assert.True(await process.WaitForReadyAsync(TimeSpan.FromSeconds(5), CancellationToken.None));
        Assert.Equal(41800, process.SocksPort);
        Assert.Equal(45555, process.StatusPort);
        Assert.False(process.HasExited);

        await process.StopAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        await WaitUntilAsync(() => process.HasExited);
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public void MissingBinary_NamesTheSearchedPaths()
    {
        var missing = Path.Combine(_directory.FullName, "does-not-exist");
        var error = Assert.Throws<TunnelHelperStartException>(() => Launcher(missing).Start(Config()));
        Assert.Equal($"helper binary not found (looked for {missing})", error.Message);
    }

    [Fact]
    public void Locator_PrefersConfiguredPath_ThenAssemblyDirectory()
    {
        var env = new FakeEnvironment(_directory.FullName);
        var unset = new TunnelHelperLocator(Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()), env);
        Assert.Equal(Path.Combine(AppContext.BaseDirectory, TunnelHelperLocator.BinaryName), unset.Candidates()[0]);
        Assert.Equal(Path.Combine(_directory.FullName, "tunnel", TunnelHelperLocator.BinaryName), unset.Candidates()[1]);

        var configured = new TunnelHelperLocator(
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { Tunnels = new TunnelsOptions { HelperPath = "bin/helper" } }), env);
        Assert.Equal([Path.Combine(_directory.FullName, "bin", "helper")], configured.Candidates());
    }

    [Fact]
    public async Task RealHelper_AgainstAnUnreachableEndpoint_IsDownWithHandshakeTimeout()
    {
        var helper = TunnelHelperBinary.Locate();
        if (helper is null)
        {
            output.WriteLine("streamarr-tunnel is not built; run server/scripts/build-tunnel-helper.sh to enable this test.");
            return;
        }

        await using var process = Launcher(helper).Start(Config());
        Assert.True(await process.WaitForReadyAsync(TimeSpan.FromSeconds(10), CancellationToken.None), process.LastErrorMessage);
        Assert.True(process.SocksPort > 0 && process.StatusPort > 0, "ready line must carry the ephemeral ports");

        var status = await process.GetStatusAsync(CancellationToken.None);
        Assert.Equal("192.0.2.1:51820", status.Endpoint);
        Assert.Null(status.LastHandshakeUtc);
        Assert.Equal(process.SocksPort, status.SocksPort);

        await process.StopAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        await WaitUntilAsync(() => process.HasExited);
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public async Task RealHelper_UnderTheSupervisor_TransitionsStartingToDownOnHandshakeTimeout()
    {
        var helper = TunnelHelperBinary.Locate();
        if (helper is null)
        {
            output.WriteLine("streamarr-tunnel is not built; run server/scripts/build-tunnel-helper.sh to enable this test.");
            return;
        }

        var dbOptions = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(_directory.FullName, "tunnels.db")}")
            .Options;
        await using (var setup = new StreamarrDbContext(dbOptions))
            await setup.Database.EnsureCreatedAsync();
        var tunnels = new TunnelConfigService(new PooledDbContextFactory<StreamarrDbContext>(dbOptions), new PassThroughProtector(), TimeProvider.System);
        var entity = await tunnels.CreateAsync(new NormalizedTunnel(
            "Unreachable", "custom", "192.0.2.1:51820", ["10.64.12.3/32"], ["10.64.0.1"], null, 5,
            TunnelValidationTests.PeerKey, ["0.0.0.0/0"], TunnelValidationTests.PrivateKey, null), enabled: true, CancellationToken.None);
        var timings = new TunnelSupervisorTimings
        {
            PollInterval = TimeSpan.FromMilliseconds(200),
            FirstPollDelay = TimeSpan.FromMilliseconds(200),
            HandshakeTimeout = TimeSpan.FromSeconds(2),
            RestartBackoffInitial = TimeSpan.FromMilliseconds(100),
        };
        var options = Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { Tunnels = new TunnelsOptions { HelperPath = helper, ExitCheckUrl = "http://10.64.0.1/ip" } });
        await using var supervisor = new TunnelSupervisor(tunnels, Launcher(helper), timings, options, TimeProvider.System, NullLogger<TunnelSupervisor>.Instance);

        await supervisor.ReloadAsync(CancellationToken.None);
        Assert.Equal(TunnelStates.Starting, supervisor.GetStatus(entity.Id)!.State);

        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (supervisor.GetStatus(entity.Id)!.State != TunnelStates.Down && DateTime.UtcNow < deadline)
            await Task.Delay(100);

        var status = supervisor.GetStatus(entity.Id)!;
        output.WriteLine($"state={status.State} lastError={status.LastError}");
        Assert.Equal(TunnelStates.Down, status.State);
        Assert.StartsWith("handshake timeout: no handshake with 192.0.2.1:51820 after ", status.LastError);
        Assert.Null(supervisor.ProxyEndpoint(entity.Id));
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                Assert.Fail("Timed out waiting for the helper process.");
            await Task.Delay(20);
        }
    }

    private sealed class PassThroughProtector : ISecretProtector
    {
        public string? Protect(string? plaintext) => string.IsNullOrEmpty(plaintext) ? null : plaintext;
        public string Unprotect(string? ciphertext) => ciphertext ?? string.Empty;
    }

    internal sealed class FakeEnvironment(string contentRoot) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ApplicationName { get; set; } = "Streamarr.Server.Tests";
        public string ContentRootPath { get; set; } = contentRoot;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

/// <summary>Finds a built streamarr-tunnel for tests: next to the test assembly (copied by the csproj) or the repo's dist/host build; builds it with Go when possible.</summary>
internal static class TunnelHelperBinary
{
    private static readonly Lazy<string?> Located = new(LocateOrBuild, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string? Locate() => Located.Value;

    private static string? LocateOrBuild()
    {
        var local = Path.Combine(AppContext.BaseDirectory, TunnelHelperLocator.BinaryName);
        if (File.Exists(local))
            return local;
        var tunnelDir = FindTunnelSourceDir();
        if (tunnelDir is null)
            return null;
        var dist = Path.Combine(tunnelDir, "dist", "host", TunnelHelperLocator.BinaryName);
        if (File.Exists(dist))
            return dist;
        try
        {
            var build = new System.Diagnostics.ProcessStartInfo("bash", Path.Combine(tunnelDir, "build.sh"))
            {
                WorkingDirectory = tunnelDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = System.Diagnostics.Process.Start(build);
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
