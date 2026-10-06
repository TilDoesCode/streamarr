using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace Streamarr.Server.Transcoding;

public sealed record ProcessResult(
    int ExitCode,
    string StandardOutput,
    string StandardError,
    TimeSpan Elapsed,
    TimeSpan CpuTime,
    bool TimedOut)
{
    public bool Succeeded => ExitCode == 0 && !TimedOut;
}

/// <summary>Runs short-lived helper processes (ffmpeg/ffprobe) with bounded output, timeouts and tree kill.</summary>
public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken ct);
}

public sealed class ProcessRunner : IProcessRunner
{
    internal const int MaxOutputChars = 1024 * 1024;

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<int, Process> Running = new();

    static ProcessRunner() => AppDomain.CurrentDomain.ProcessExit += (_, _) => KillAll();

    /// <summary>SIGKILLs the tree of every helper process still running, so none outlives the server.</summary>
    public static void KillAll()
    {
        foreach (var process in Running.Values)
            Kill(process);
    }

    public async Task<ProcessResult> RunAsync(
        string fileName, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        FfmpegEnvironment.Apply(psi);
        foreach (var argument in arguments)
            psi.ArgumentList.Add(argument);

        var watch = Stopwatch.StartNew();
        using var process = new Process { StartInfo = psi };
        process.Start();
        Running[process.Id] = process;
        try
        {
            return await WaitAsync(process, watch, timeout, ct);
        }
        finally
        {
            Running.TryRemove(process.Id, out _);
            Kill(process);
        }
    }

    private static async Task<ProcessResult> WaitAsync(Process process, Stopwatch watch, TimeSpan timeout, CancellationToken ct)
    {
        var cpu = TimeSpan.Zero;

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        var stdout = ReadBoundedAsync(process.StandardOutput);
        var stderr = ReadBoundedAsync(process.StandardError);
        var timedOut = false;
        try
        {
            while (!process.HasExited)
            {
                cpu = SampleCpu(process, cpu);
                var exited = process.WaitForExitAsync(timeoutCts.Token);
                if (await Task.WhenAny(exited, Task.Delay(200, timeoutCts.Token)) == exited)
                {
                    await exited;
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            timedOut = !ct.IsCancellationRequested;
            Kill(process);
            if (!timedOut)
                throw;
        }

        try
        {
            await process.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (TimeoutException)
        {
        }

        watch.Stop();
        return new ProcessResult(
            process.HasExited ? process.ExitCode : -1,
            await stdout,
            await stderr,
            watch.Elapsed,
            cpu,
            timedOut);
    }

    internal static TimeSpan SampleCpu(Process process, TimeSpan previous)
    {
        try
        {
            return process.HasExited ? previous : process.TotalProcessorTime;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return previous;
        }
    }

    internal static void Kill(Process process)
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

    private static async Task<string> ReadBoundedAsync(StreamReader reader)
    {
        var builder = new StringBuilder();
        var buffer = new char[8192];
        int read;
        while ((read = await reader.ReadAsync(buffer, CancellationToken.None)) > 0)
        {
            var room = MaxOutputChars - builder.Length;
            if (room > 0)
                builder.Append(buffer, 0, Math.Min(room, read));
        }
        return builder.ToString();
    }
}

/// <summary>Pauses and resumes a process tree root via POSIX job-control signals.</summary>
/// <summary>Removes stream capability tokens and local paths from ffmpeg diagnostics before they are stored or shown.</summary>
public static partial class TranscodeRedaction
{
    [GeneratedRegex(@"/api/v1/stream/[A-Za-z0-9_\-%.]+", RegexOptions.CultureInvariant)]
    private static partial Regex StreamCapability();

    [GeneratedRegex(@"/api/v1/transcode/[A-Za-z0-9_\-%.]+", RegexOptions.CultureInvariant)]
    private static partial Regex TranscodeCapability();

    public static string Redact(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return string.Empty;
        var result = StreamCapability().Replace(text, "/api/v1/stream/{capability}");
        return TranscodeCapability().Replace(result, "/api/v1/transcode/{capability}");
    }

    private static readonly string[] SignificantPhrases =
    [
        "not support", "doesn't support", "Failed", "failed", "Cannot", "cannot", "No VA display", "Permission denied", "No such file",
        "Device creation", "Error initializing", "Invalid", "not found", "Unknown", "unsupported", "No device",
    ];

    [GeneratedRegex(@" @ 0x[0-9a-f]+", RegexOptions.CultureInvariant)]
    private static partial Regex PointerAddress();

    /// <summary>The most diagnostic lines of an ffmpeg stderr capture, falling back to its tail.</summary>
    public static string Summarize(string? stderr, int maxLines = 3)
    {
        var lines = Redact(stderr)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(l => PointerAddress().Replace(l, string.Empty))
            .Distinct()
            .ToList();
        var significant = lines.Where(l => SignificantPhrases.Any(p => l.Contains(p, StringComparison.Ordinal))).Take(maxLines).ToList();
        return string.Join('\n', significant.Count > 0 ? significant : lines.TakeLast(maxLines));
    }

    public static IReadOnlyList<string> RedactArguments(IEnumerable<string> arguments)
        => arguments.Select(Redact).ToList();

    public static string Tail(string text, int maxLines)
    {
        var lines = Redact(text)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var deduped = new List<string>();
        foreach (var line in lines)
        {
            if (deduped.Count == 0 || deduped[^1] != line)
                deduped.Add(line);
        }
        return string.Join('\n', deduped.TakeLast(maxLines));
    }
}
