using System.Diagnostics;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Tests.Transcoding;

public sealed class ProcessRunnerTests
{
    [Fact]
    public async Task Timeout_KillsTheWholeProcessTree()
    {
        if (OperatingSystem.IsWindows())
            return;
        var marker = Path.Combine(Path.GetTempPath(), $"streamarr-runner-{Guid.NewGuid():N}");
        var watch = Stopwatch.StartNew();

        var result = await new ProcessRunner().RunAsync("/bin/sh", ["-c", $"sleep 30 & echo $! > {marker}; wait"], TimeSpan.FromSeconds(1), CancellationToken.None);

        Assert.True(result.TimedOut);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15));
        var child = int.Parse((await File.ReadAllTextAsync(marker)).Trim());
        File.Delete(marker);
        await Task.Delay(200);
        Assert.False(Alive(child));
    }

    private static bool Alive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
